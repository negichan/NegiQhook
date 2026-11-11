'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Taps see every line, including the levels the console threshold hides, so the
// debug page can show debug output without running the whole endpoint in debug.
const taps = [];

function addTap(fn) {
  if (typeof fn !== 'function') return () => {};
  taps.push(fn);
  return () => {
    const at = taps.indexOf(fn);
    if (at !== -1) taps.splice(at, 1);
  };
}

function createLogger(level = 'info', source = '') {
  const threshold = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];
  const tag = source ? `[${source}] ` : '';
  const write = (name, args) => {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const text = args.map((value) => {
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch (e) { return String(value); }
      }
      return String(value);
    }).join(' ');
    const line = `${stamp} [${name}] ${tag}${text}`;
    for (const tap of taps) {
      try { tap(name, text, line, source); } catch (e) { /* a broken tap must not stop logging */ }
    }
    if (LEVELS[name] > threshold) return;
    if (name === 'error' || name === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    error: (...args) => write('error', args),
    warn: (...args) => write('warn', args),
    info: (...args) => write('info', args),
    debug: (...args) => write('debug', args),
    // The name used to be dropped, which made the debug page unable to tell a
    // bridge line from a satori one.
    child: (name) => createLogger(level, name ? (source ? `${source}.${name}` : String(name)) : source)
  };
}

module.exports = { createLogger, addTap, LEVELS };
