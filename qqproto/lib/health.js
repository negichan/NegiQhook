'use strict';

// A small JSON file the launcher can read without asking the endpoint process
// anything. The endpoint rewrites it every few seconds; a stale mtime is what
// lets the supervisor tell "node.exe is alive" from "the event loop is stuck".
//
// It is deliberately not a network surface: the debug page already has
// /health, and the file is only written where the profile lives.

const fs = require('fs');
const path = require('path');

function writeHealth(file, snapshot) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

function readHealth(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function startHealthWriter({ file, snapshot, intervalMs = 5000, logger }) {
  if (!file) return { stop() {} };
  const tick = () => {
    const value = typeof snapshot === 'function' ? snapshot() : snapshot;
    if (!writeHealth(file, value) && logger) {
      logger.warn('could not write health file ' + file);
    }
  };
  tick();
  const timer = setInterval(tick, Math.max(1000, Number(intervalMs) || 5000));
  if (timer.unref) timer.unref();
  return {
    path: file,
    stop() {
      clearInterval(timer);
      try { fs.rmSync(file, { force: true }); } catch (e) { /* gone */ }
    }
  };
}

module.exports = { writeHealth, readHealth, startHealthWriter };
