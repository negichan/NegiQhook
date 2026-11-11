// A raw-mode line editor for the launcher's console, so the instance can be
// driven like a game server console: a prompt that survives interleaved log
// output, up/down history, Tab completion, and editing keys that behave.
//
// Why not readline? readline writes its own prompt and cannot be told "print
// these log lines and give me back my half-typed input line" without hacks, and
// it has no idea that a Chinese nickname is two columns wide - which is exactly
// what a QQ console deals with all day. Owning the redraw is the only way the
// prompt stops jumping around while [ep]/[qq] lines stream in.
//
// When stdin is not a terminal (piped, or the task runner took the console away)
// everything degrades to reading whole lines and writing plain text: no escapes,
// no raw mode, same command set.

'use strict';

const { StringDecoder } = require('string_decoder');

// Combining marks take no cell; the ranges below take two in a monospace font
// (CJK, Hangul, kana, fullwidth forms, boxes/block/emoji). Written as escapes so
// this file stays readable in an editor that is not set to UTF-8.
const ZERO_WIDTH = /[\u0300-\u036F\u200B-\u200F\uFE00-\uFE0F\u20D0-\u20FF]/u;
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3780-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}]/u;

function charWidth(ch) {
  if (ZERO_WIDTH.test(ch)) return 0;
  return WIDE.test(ch) ? 2 : 1;
}

function textWidth(text) {
  let width = 0;
  for (const ch of String(text || '')) width += charWidth(ch);
  return width;
}

// Escape sequences we consume explicitly. Anything else starting with ESC
// (function keys, focus events, mouse) is dropped: a console that echoed half a
// CSI sequence into the input line would look broken.
const KEYS = Object.freeze({
  '\r': 'enter', '\n': 'enter', '\x08': 'backspace', '\x7f': 'backspace',
  '\t': 'tab', '\x1b[Z': 'backtab', '\x03': 'ctrl-c', '\x04': 'ctrl-d',
  '\x0c': 'ctrl-l', '\x15': 'ctrl-u', '\x0b': 'ctrl-k', '\x01': 'ctrl-a',
  '\x05': 'ctrl-e', '\x17': 'ctrl-w', '\x1b[A': 'up', '\x1b[B': 'down',
  '\x1b[C': 'right', '\x1b[D': 'left', '\x1b[H': 'home', '\x1b[F': 'end',
  '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[3~': 'delete',
  '\x1b[1;5C': 'ctrl-right', '\x1b[1;5D': 'ctrl-left',
  '\x1bOH': 'home', '\x1bOF': 'end', '\x1b[D3~': 'delete'
});

function createLineEditor(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const emit = typeof options.write === 'function'
    ? options.write
    : (chunk) => { try { output.write(chunk); } catch (e) { /* closed */ } };

  const isTty = Boolean(options.tty !== undefined ? options.tty : (output.isTTY && input.isTTY));
  const terminal = () => ({ columns: output.columns || 80, rows: output.rows || 24 });

  // Two renderers, because "the console" on Windows is not one thing: a VT-capable
  // host (Windows Terminal, any xterm) parses escape sequences, and the plain
  // conhost that cmd.exe opens on Windows 10 does not - there an ANSI cursor move
  // is printed as literal junk like "[0J". So: start in the safe single-row
  // renderer (carriage return, spaces, backspace - things every console has) and
  // ask the host for its cursor position once. A real VT host answers with
  // "CSI row;col R" within a few milliseconds, and only then do we turn on
  // multi-row painting and colour.
  //
  // options.vt: true starts in the VT renderer, false never probes (tests, and
  // anyone who wants plain output).
  const state = {
    prompt: options.prompt || '> ',
    chars: [],            // Array.from() of the line: keeps surrogate pairs whole
    cursor: 0,            // index into chars, never a column
    history: Array.isArray(options.history) ? options.history.slice() : [],
    historyIndex: -1,     // -1 = the line being typed now
    staged: '',           // the in-progress line saved while walking history
    shown: false,         // is a prompt currently on screen?
    started: false,
    bell: options.bell !== false && isTty,
    lastInterrupt: 0,
    mode: options.vt === true ? 'vt' : 'plain',
    probing: isTty && options.vt === undefined,
    paintedCells: 0       // how much of the row the last paint filled (plain erase)
  };

  const vt = () => state.mode === 'vt';

  const decoder = new StringDecoder('utf8');
  let pending = '';       // bytes of an escape sequence split across reads

  function width() { return textWidth(state.prompt); }
  function cellsBefore(index) {
    let n = 0;
    for (let i = 0; i < index && i < state.chars.length; i++) n += charWidth(state.chars[i]);
    return n;
  }

  // Plain mode keeps the whole input on one row: when it grows past the width the
  // visible window slides, so the cursor stays inside it. Nothing is lost - the
  // buffer is the buffer - and no vertical movement is ever needed. The row stops
  // a couple of cells short of the terminal width, because writing into the last
  // cell is where a console starts to wrap.
  function visibleWindow() {
    const cols = Math.max(20, terminal().columns);
    const budget = Math.max(1, cols - width() - 2);
    const before = state.chars.slice(0, state.cursor);
    const after = state.chars.slice(state.cursor);
    let head = before.join('');
    while (textWidth(head) > budget && Array.from(head).length > 1) {
      head = Array.from(head).slice(1).join('');
    }
    const room = Math.max(0, budget - textWidth(head));
    const picked = [];
    let used = 0;
    for (const ch of Array.from(after).reverse()) {
      if (used + charWidth(ch) > room) break;
      used += charWidth(ch);
      picked.unshift(ch);
    }
    return { line: head + picked.join(''), cursorText: head };
  }

  // Move the hardware cursor to `chars[state.cursor]` after painting the line.
  // Rows/cols are computed from the wrapped length, because a long `say` text
  // wraps and the naive "cursor back N cells" then lands on the wrong row.
  function placeCursor() {
    if (!isTty || !vt()) return;
    const cols = Math.max(20, terminal().columns);
    const total = width() + cellsBefore(state.cursor);
    const row = Math.floor(total / cols);
    const col = total % cols;
    let out = '\r';
    if (row > 0) out += '\x1b[' + row + 'A';
    if (col > 0) out += '\x1b[' + col + 'C';
    emit(out);
  }

  // The renderer every console has: carriage return, spaces, and a line that never
  // wraps (the visible window slides instead). No escape sequences at all.
  function paintPlain() {
    const view = visibleWindow();
    const cols = Math.max(20, terminal().columns);
    const line = state.prompt + view.line;
    const cells = textWidth(line);
    // Padding to the end of the row is also what erases the probe reply, a stale
    // longer paint, and any leftover from the log stream above.
    const pad = Math.max(1, cols - cells);
    emit('\r' + line + ' '.repeat(pad) + '\r' + state.prompt + view.cursorText);
    state.paintedCells = cells;
    state.shown = true;
  }

  function eraseRow() {
    const cols = Math.max(20, terminal().columns);
    emit('\r' + ' '.repeat(cols) + '\r');
    state.paintedCells = 0;
  }

  function paint() {
    if (!isTty) return;
    if (!vt()) { paintPlain(); return; }
    const cols = Math.max(20, terminal().columns);
    const before = state.prompt + state.chars.slice(0, state.cursor).join('');
    const rest = state.chars.slice(state.cursor).join('');
    const total = textWidth(before) + textWidth(rest);
    const lines = Math.floor(total / Math.max(20, terminal().columns)) + 1;
    // Clear the rows the prompt occupied (and any junk below it), then repaint.
    const row = Math.floor(textWidth(before) / cols);
    let out = '\r';
    if (row > 0) out += '\x1b[' + row + 'A';
    out += '\x1b[0J';
    // The final row of a wrapped line may need padding so an older, longer paint
    // does not leave ghosts at the end.
    out += state.prompt + state.chars.join('') + (lines === 1 ? ' ' : '');
    emit(out);
    state.shown = true;
    state.paintedCells = 0;
    placeCursor();
  }

  function promptText() { return state.prompt; }

  function clearLine(message) {
    state.chars = [];
    state.cursor = 0;
    state.historyIndex = -1;
    state.staged = '';
    if (message) {
      if (vt()) emit('\r\x1b[0J' + message + '\n');
      else { eraseRow(); emit(message + '\n'); }
      state.shown = false;
    }
    paint();
  }

  function bell() { if (state.bell) emit('\x07'); }

  function insert(text) {
    const chars = Array.from(String(text || ''));
    if (!chars.length) return;
    state.chars.splice(state.cursor, 0, ...chars);
    state.cursor += chars.length;
    paint();
  }

  function wordAtCursor() {
    const text = state.chars.slice(0, state.cursor).join('');
    const match = /(\S*)$/.exec(text);
    return { start: state.cursor - match[1].length, token: match[1] };
  }

  function wordBack() {
    let i = state.cursor;
    while (i > 0 && /\s/.test(state.chars[i - 1])) i--;
    while (i > 0 && !/\s/.test(state.chars[i - 1])) i--;
    return i;
  }

  // Tab: complete against the caller's list. A unique match is applied; several
  // print as a dim column (like a server console does for player names) and the
  // common prefix is applied so another Tab narrows it further.
  function complete() {
    const line = state.chars.join('');
    const lister = options.onComplete;
    if (!lister) { bell(); return; }
    let result;
    try {
      result = lister({ line, prompt: promptText(), cursor: state.cursor, token: wordAtCursor().token });
    } catch (e) {
      if (options.onError) options.onError(e);
      return;
    }
    const list = (result && Array.isArray(result.list)) ? result.list : (Array.isArray(result) ? result : []);
    const base = wordAtCursor().token;
    const at = wordAtCursor().start;
    const hits = list.filter((item) => String(item).startsWith(base) && String(item) !== base);
    if (!hits.length) {
      const exact = list.filter((item) => String(item) === base);
      if (exact.length) { bell(); return; }
      bell();
      return;
    }
    if (hits.length > 1) {
      let prefix = String(hits[0]);
      for (const hit of hits) {
        const value = String(hit);
        let i = 0;
        while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
        prefix = prefix.slice(0, i);
      }
      if (prefix.length > base.length) {
        state.chars.splice(at, state.cursor - at, ...Array.from(prefix));
        state.cursor = at + Array.from(prefix).length;
        paint();
      }
      if (options.showChoices) options.showChoices(hits.map(String), base);
      else paint();
      return;
    }
    const value = String(hits[0]);
    state.chars.splice(at, state.cursor - at, ...Array.from(value));
    state.cursor = at + Array.from(value).length;
    // A completed word at the end of the line gets a trailing space so the next
    // Tab (or the next argument) starts clean.
    if (state.cursor === state.chars.length) insert(' ');
    else paint();
  }

  function submit() {
    const line = state.chars.join('');
    emit('\n');
    state.shown = false;
    state.chars = [];
    state.cursor = 0;
    state.historyIndex = -1;
    state.staged = '';
    const trimmed = line.trim();
    if (trimmed) {
      if (state.history[state.history.length - 1] !== trimmed) state.history.push(trimmed);
      if (options.onSubmit) options.onSubmit(line);
    }
    if (state.history.length > 400) state.history.splice(0, state.history.length - 400);
    if (isTty) paint();
  }

  function walkHistory(direction) {
    if (!state.history.length) { bell(); return; }
    if (direction < 0) {
      if (state.historyIndex === -1) {
        state.staged = state.chars.join('');
        state.historyIndex = state.history.length;
      }
      state.historyIndex = Math.max(0, state.historyIndex - 1);
    } else {
      if (state.historyIndex === -1) { bell(); return; }
      state.historyIndex = Math.min(state.history.length, state.historyIndex + 1);
    }
    const value = state.historyIndex === state.history.length
      ? state.staged
      : state.history[state.historyIndex];
    state.chars = Array.from(value);
    state.cursor = state.chars.length;
    paint();
  }

  function onData(chunk) {
    let text = pending + decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    pending = '';
    if (state.probing) text = consumeProbeReply(text);
    // An escape sequence can be cut in half by the OS; hold the tail back.
    const esc = text.lastIndexOf('\x1b');
    if (esc >= 0 && esc === text.length - 1) { pending = '\x1b'; text = text.slice(0, esc); }
    else if (esc >= 0) {
      const tail = text.slice(esc);
      if (/^\x1b\[[0-9;]*[A-Za-z]?$/.test(tail) && !/^\x1b\[[0-9;]*[A-Za-z]/.test(tail)) {
        pending = tail;
        text = text.slice(0, esc);
      }
    }
    for (const token of splitTokens(text)) handleToken(token);
  }

  // Split a decoded chunk into single characters and escape sequences.
  function splitTokens(text) {
    const out = [];
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === '\x1b') {
        let j = i + 1;
        let seq = ch;
        if (chars[j] === '[' || chars[j] === 'O') {
          seq += chars[j];
          j++;
          while (j < chars.length && !/[A-Za-z~]/.test(chars[j])) { seq += chars[j]; j++; }
          if (j < chars.length) { seq += chars[j]; j++; }
        }
        out.push(seq);
        i = j - 1;
        continue;
      }
      out.push(ch);
    }
    return out;
  }

  function handleToken(token) {
    const key = KEYS[token];
    switch (key) {
      case 'enter':
        submit();
        return;
      case 'backspace':
        if (state.cursor > 0) { state.chars.splice(state.cursor - 1, 1); state.cursor--; paint(); }
        else bell();
        return;
      case 'delete':
        if (state.cursor < state.chars.length) { state.chars.splice(state.cursor, 1); paint(); }
        return;
      case 'left':
        if (state.cursor > 0) { state.cursor--; placeCursor(); }
        return;
      case 'right':
        if (state.cursor < state.chars.length) { state.cursor++; placeCursor(); }
        return;
      case 'ctrl-left': {
        const at = wordBack();
        state.cursor = at;
        placeCursor();
        return;
      }
      case 'ctrl-right': {
        let i = state.cursor;
        while (i < state.chars.length && /\s/.test(state.chars[i])) i++;
        while (i < state.chars.length && !/\s/.test(state.chars[i])) i++;
        state.cursor = i;
        placeCursor();
        return;
      }
      case 'home':
        state.cursor = 0;
        placeCursor();
        return;
      case 'end':
        state.cursor = state.chars.length;
        placeCursor();
        return;
      case 'ctrl-a':
        state.cursor = 0;
        placeCursor();
        return;
      case 'ctrl-e':
        state.cursor = state.chars.length;
        placeCursor();
        return;
      case 'ctrl-u':
        state.chars.splice(0, state.cursor);
        state.cursor = 0;
        paint();
        return;
      case 'ctrl-k':
        state.chars.splice(state.cursor);
        paint();
        return;
      case 'ctrl-w': {
        const at = wordBack();
        state.chars.splice(at, state.cursor - at);
        state.cursor = at;
        paint();
        return;
      }
      case 'ctrl-l':
        clearScreen();
        paint();
        return;
      case 'tab':
        complete();
        return;
      case 'backtab':
        return;
      case 'ctrl-c': {
        const now = Date.now();
        const again = now - state.lastInterrupt < 2000;
        state.lastInterrupt = now;
        clearLine('');
        if (options.onInterrupt) options.onInterrupt(again ? 'double' : 'single');
        if (!again && options.interruptHint) emit('\x1b[2m' + options.interruptHint + '\x1b[0m\n');
        return;
      }
      case 'ctrl-d':
        if (state.chars.length === 0) {
          if (options.onEof) options.onEof();
          else emit('\n');
          return;
        }
        // Non-empty line: delete the character under the cursor (bash behaviour).
        if (state.cursor < state.chars.length) { state.chars.splice(state.cursor, 1); paint(); }
        return;
      case 'up':
        walkHistory(-1);
        return;
      case 'down':
        walkHistory(1);
        return;
      default:
        break;
    }
    if (token === '\x1b') { bell(); return; }
    if (token.length === 1 && (token === '\x1b' || token.charCodeAt(0) >= 0x20)) insert(token);
  }

  // Interleaved output is the whole point of this file: a log line must not
  // scramble the half-typed command. Clear the prompt area, print, repaint.
  function print(message) {
    const text = String(message === undefined ? '' : message);
    if (!isTty) { emit(text + '\n'); return; }
    if (state.shown) {
      if (!vt()) eraseRow();
      const before = state.prompt + state.chars.slice(0, state.cursor).join('');
      const row = Math.floor(textWidth(before) / Math.max(20, terminal().columns));
      emit('\r');
      if (row > 0) emit('\x1b[' + row + 'A');
      if (vt()) emit('\x1b[0J');
    }
    emit(text + '\n');
    if (state.shown) paint();
  }

  function clearScreen() {
    if (!isTty) return;
    state.shown = false;
    state.paintedCells = 0;
    if (vt()) { emit('\x1b[2J\x1b[H'); return; }
    // No ANSI: push a screenful of blank lines so the prompt repaints at the
    // bottom of a clean window. Slower, but it never prints an escape sequence.
    emit('\n'.repeat(Math.max(1, terminal().rows)));
  }

  // A VT host answers "report cursor position" with CSI row;col R; the plain
  // console host leaves it on screen and says nothing. Silence is the signal to
  // stay in the plain renderer.
  function probeVt() {
    if (!state.probing) return;
    emit('\x1b[6n');
    const timer = setTimeout(() => {
      state.probing = false;
      if (options.onMode) options.onMode(state.mode);
    }, Math.max(50, options.vtTimeoutMs || 300));
    if (typeof timer.unref === 'function') timer.unref();
    state.probeTimer = timer;
  }

  function consumeProbeReply(text) {
    const match = /\x1b\[[0-9;]*R/.exec(text);
    if (!match) return text;
    if (state.probeTimer) clearTimeout(state.probeTimer);
    state.probing = false;
    state.mode = 'vt';
    if (options.onMode) options.onMode('vt');
    paint();
    return text.slice(0, match.index) + text.slice(match.index + match[0].length);
  }

  function start() {
    if (state.started) return;
    state.started = true;
    if (!isTty) {
      // Piped stdin: whole lines only, no escapes anywhere.
      let rest = '';
      input.on('data', (chunk) => {
        const text = rest + String(chunk);
        const parts = text.split(/\r?\n/);
        rest = parts.pop();
        for (const line of parts) {
          if (!line.trim()) continue;
          emit(state.prompt + line + '\n');
          if (options.onSubmit) options.onSubmit(line);
        }
      });
      input.on('end', () => {
        if (rest.trim()) { if (options.onSubmit) options.onSubmit(rest); rest = ''; }
        if (options.onEof) options.onEof();
      });
      return;
    }
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    // Probe first: a console that does not parse the sequence prints four
    // characters on our row, and the paint right below erases the whole row.
    probeVt();
    paint();
  }

  function setPrompt(value) {
    state.prompt = String(value || '');
    if (isTty && state.shown) paint();
  }

  function getBuffer() { return state.chars.join(''); }

  function stop() {
    if (!state.started) return;
    state.started = false;
    if (isTty) {
      input.removeListener('data', onData);
      if (typeof input.setRawMode === 'function') input.setRawMode(false);
      input.pause();
      if (vt()) emit('\r\x1b[0J');
      else eraseRow();
    } else {
      input.pause();
    }
    if (state.probeTimer) clearTimeout(state.probeTimer);
    state.probing = false;
  }

  return {
    start, stop, print, setPrompt, getBuffer, clearScreen,
    get mode() { return isTty ? state.mode : 'none'; },
    get history() { return state.history; },
    setPromptOnly: setPrompt,
    helpers: { textWidth, charWidth }
  };
}

module.exports = { createLineEditor, textWidth, charWidth };
