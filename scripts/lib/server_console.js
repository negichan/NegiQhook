// The console loop itself: prompt, command registry, help, colours, a status
// line, and the rule that a log line never eats what you are typing.
//
// This is deliberately generic - it knows nothing about QQ. headless_launch.js
// feeds it the command set (lib/instance_console.js) and the two log tails, so
// the same loop can drive a headed client, a headless one, or a test harness.

'use strict';

const { createLineEditor } = require('./line_editor');

const CODES = {
  reset: 0, bold: 1, dim: 2, underline: 4,
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  grey: 90
};

// Colour is a courtesy, not a feature: piped output, NO_COLOR, a plain console
// host that would print the escapes as junk, or --no-color all get plain text,
// because a stray escape sequence in a redirected log is worse than no colour.
function makePainter(allowed) {
  const on = typeof allowed === 'function' ? allowed : () => Boolean(allowed);
  return function paint(text, style) {
    const value = String(text === undefined || text === null ? '' : text);
    if (!on() || !style) return value;
    if (process.env.NO_COLOR) return value;
    const code = CODES[style];
    if (code === undefined) return value;
    return '\x1b[' + code + 'm' + value + '\x1b[0m';
  };
}

// Split a command line into tokens, with "double quotes" grouping arguments that
// contain spaces (a QQ nickname always does).
function tokenize(line) {
  const tokens = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of String(line || '')) {
    if (ch === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function createServerConsole(options = {}) {
  const output = options.output || process.stdout;
  const input = options.input || process.stdin;
  const tty = options.tty !== undefined
    ? Boolean(options.tty)
    : Boolean(output.isTTY && input.isTTY);
  const paint = makePainter(() => tty && vtMode);
  // Flipped by the editor once the host answers (or refuses) the cursor-position
  // probe: colour and multi-row painting only go on when the console can take it.
  let vtMode = options.vt === true;

  const state = {
    prompt: options.prompt || '> ',
    started: false,
    closed: false,
    // Watching means a status line lands in the log stream every few seconds.
    // Off by default: a server console that talks over you is not a console.
    watchMs: 0,
    watchTimer: null,
    running: 0
  };

  const registry = new Map();
  const aliases = new Map();
  for (const command of (options.commands || [])) addCommand(command);

  const writer = {
    paint,
    tty,
    raw: (text) => editor ? editor.print(text) : emitPlain(text),
    log: (text, style) => emitLine(paint(text, style)),
    info: (text) => emitLine(paint(text, 'cyan')),
    ok: (text) => emitLine(paint(text, 'green')),
    warn: (text) => emitLine(paint(text, 'yellow')),
    error: (text) => emitLine(paint(text, 'red')),
    dim: (text) => emitLine(paint(text, 'grey')),
    bullet: (label, text, style) => emitLine(paint(label, 'bold') + ' ' + paint(text, style)),
    table: (rows, style) => {
      for (const row of rows) emitLine(paint(row, style || 'white'));
    },
    blank: () => emitLine('')
  };

  function emitPlain(text) {
    try { output.write(String(text) + '\n'); } catch (e) { /* closed */ }
  }

  function emitLine(text) {
    if (editor) editor.print(text);
    else emitPlain(text);
  }

  function addCommand(command) {
    if (!command || !command.name) throw new Error('command needs a name');
    registry.set(command.name, command);
    for (const alias of (command.aliases || [])) aliases.set(alias, command.name);
    return command;
  }

  // ---- built-ins that every server console has -------------------------------
  addCommand({
    name: 'help',
    aliases: ['?'],
    group: '控制台',
    usage: 'help [命令]',
    desc: '命令表，或者某个命令的详细说明',
    run: ({ args }) => {
      if (args.length) {
        const name = args[0].toLowerCase();
        const command = registry.get(name) || registry.get(aliases.get(name) || '');
        if (!command) return [paint('没有这个命令：' + name, 'red')];
        return [
          paint(command.usage || command.name, 'bold'),
          '  ' + command.desc,
          ...(command.detail ? command.detail.split('\n').map((line) => paint('  ' + line, 'grey')) : []),
          ...(command.aliases && command.aliases.length
            ? [paint('  别名：' + command.aliases.join('、'), 'grey')] : [])
        ];
      }
      const groups = new Map();
      for (const command of registry.values()) {
        const key = command.group || '其它';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(command);
      }
      const lines = [paint('可用命令（Tab 补全，↑/↓ 是历史）：', 'bold')];
      for (const [group, list] of groups) {
        lines.push(paint('  ' + group, 'magenta'));
        for (const command of list) {
          const names = (command.name + (command.aliases ? ',' + command.aliases.join(',') : '')).split(',');
          lines.push('    ' + paint(names.join(' | '), 'cyan') + '  ' + paint(command.desc, 'grey'));
        }
      }
      lines.push(paint('  help <命令> 看单个命令的用法；Ctrl+C 一次是取消当前行，两次收掉整套。', 'grey'));
      return lines;
    }
  });

  addCommand({
    name: 'clear',
    aliases: ['cls'],
    group: '控制台',
    usage: 'clear',
    desc: '清屏（日志继续往下面打）',
    run: () => {
      // Ask the editor: it knows whether this console can take an ANSI clear or
      // has to scroll blank lines instead.
      if (editor) editor.clearScreen();
      return null;
    }
  });

  addCommand({
    name: 'watch',
    group: '控制台',
    usage: 'watch [on|off|<秒>]',
    desc: '定时打一行状态（默认关）',
    detail: 'watch on 是 30 秒一行；watch 10 是 10 秒；watch off 关掉。\n状态内容就是 status 的第一行，适合挂在屏幕上盯着。',
    complete: (index) => (index === 1 ? ['on', 'off'] : []),
    run: ({ args }) => {
      const value = (args[0] || 'on').toLowerCase();
      const seconds = Number(value);
      if (value === 'off') { setWatch(0); return paint('状态行已关。', 'grey'); }
      if (value === 'on') { setWatch(30000); return paint('状态行每 30 秒打一次（watch off 关掉）。', 'grey'); }
      if (Number.isFinite(seconds) && seconds > 0) {
        setWatch(Math.max(5, seconds) * 1000);
        return paint('状态行每 ' + Math.max(5, seconds) + ' 秒打一次。', 'grey');
      }
      return paint('用法：watch on|off|<秒>', 'red');
    }
  });

  function setWatch(ms) {
    state.watchMs = ms;
    if (state.watchTimer) clearInterval(state.watchTimer);
    state.watchTimer = null;
    if (!ms || !state.started) return;
    state.watchTimer = setInterval(() => {
      const line = options.status ? options.status() : '';
      if (line) emitLine(paint('[状态] ' + line, 'grey'));
    }, ms);
    if (typeof state.watchTimer.unref === 'function') state.watchTimer.unref();
  }

  // ---- dispatch --------------------------------------------------------------
  // The editor is always created: in a real terminal it owns the prompt, and on a
  // pipe it quietly degrades to whole-line input so the same commands still work.
  const editor = createLineEditor({
    input,
    output,
    tty,
    prompt: state.prompt,
    history: options.history,
    vt: options.vt,
    onMode: (mode) => { vtMode = mode === 'vt'; },
    interruptHint: '再按一次 Ctrl+C（或输入 stop）收掉整套；单独一次是清空这一行。',
    onInterrupt: (kind) => {
      if (kind === 'double' && options.onInterrupt) options.onInterrupt();
    },
    onEof: () => {
      if (options.onEof) options.onEof();
    },
    showChoices: (hits, base) => {
      emitLine(paint(base ? base + ' → ' : '', 'grey') + paint(hits.join('   '), 'cyan'));
    },
    onComplete: ({ line, cursor, token }) => {
      const tokens = tokenize(line.slice(0, cursor));
      if (!tokens.length || (line.slice(0, cursor).match(/\s/g) || []).length === 0) {
        const names = [...registry.keys()];
        for (const command of registry.values()) for (const alias of (command.aliases || [])) names.push(alias);
        names.push(...['help', 'clear', 'watch'].filter((n) => !names.includes(n)));
        return names.sort();
      }
      const head = tokens[0].replace(/^[/>]/, '').toLowerCase();
      const command = registry.get(head) || registry.get(aliases.get(head) || '');
      if (!command) return [];
      const index = tokens.length - (/\s$/.test(line.slice(0, cursor)) ? 0 : 1);
      if (!command.complete) return [];
      try {
        return command.complete(Math.max(1, index), { tokens, raw: line, token }) || [];
      } catch (e) {
        return [];
      }
    },
    onSubmit: (line) => { void run(line); }
  });

  async function run(line) {
    const text = String(line || '').trim();
    if (!text) return;
    const tokens = tokenize(text);
    const head = tokens[0].replace(/^[/>]/, '').toLowerCase();
    if (!head) return;
    const command = registry.get(head) || registry.get(aliases.get(head) || '');
    if (!command) {
      emitLine(paint('未知的命令：' + head + '　输入 help 看命令表', 'red'));
      if (options.onUnknown) options.onUnknown(head, text);
      return;
    }
    state.running++;
    try {
      const result = await command.run({
        args: tokens.slice(1),
        rest: text.slice(tokens[0].length).trim(),
        tokens,
        console: writer,
        paint
      });
      if (Array.isArray(result)) { for (const entry of result) if (entry !== null && entry !== undefined) emitLine(String(entry)); }
      else if (result !== null && result !== undefined) emitLine(String(result));
    } catch (error) {
      // A refused command that already knows why (instance stopped, gate closed)
      // is a sentence, not a stack trace: print it as it was written.
      if (error && error.dead) emitLine(paint(error.message, 'yellow'));
      else emitLine(paint('「' + head + '」失败了：' + (error && error.message ? error.message : String(error)), 'red'));
      if (options.onError) options.onError(error, head);
    } finally {
      state.running--;
    }
  }

  return {
    ...writer,
    addCommand,
    commands: registry,
    tokenize,
    start() {
      if (state.started) return;
      state.started = true;
      if (options.banner) {
        for (const line of (Array.isArray(options.banner) ? options.banner : [options.banner])) {
          emitLine(paint(line, 'grey'));
        }
      }
      if (editor) editor.start();
      if (state.watchMs) setWatch(state.watchMs);
    },
    stop() {
      state.started = false;
      if (state.watchTimer) clearInterval(state.watchTimer);
      state.watchTimer = null;
      if (editor) editor.stop();
    },
    setPrompt(value) {
      state.prompt = String(value || '');
      if (editor) editor.setPrompt(state.prompt);
    },
    // Exposed for the offline gate and for anything that wants to drive the
    // status cadence itself (the `watch` command is just a friendly wrapper).
    setWatch,
    get running() { return state.running; },
    get tty() { return tty; },
    get editor() { return editor; },
    // Escape hatch for the launcher: feed a line as if it had been typed.
    submit: (line) => run(line)
  };
}

module.exports = { createServerConsole, tokenize, makePainter };
