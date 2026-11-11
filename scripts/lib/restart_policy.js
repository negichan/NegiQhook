'use strict';

// Restart pacing for the endpoint supervisor. Kept separate from the launcher so
// the policy can be tested without spawning QQ or a second Node process.
//
// A failure inside `windowMs` counts against the same budget; a success (or a
// quiet period longer than the window) starts a new one. Delay grows
// exponentially and is capped, so a port conflict or a broken build is retried
// a few times and then given up on instead of spinning forever.

function createRestartPolicy({
  max = 5,
  baseMs = 1500,
  maxMs = 20000,
  windowMs = 300000,
  now = Date.now
} = {}) {
  let attempts = 0;
  let windowStart = null;

  function fail(at) {
    const time = Number.isFinite(at) ? at : now();
    if (windowStart === null || time - windowStart > windowMs) {
      attempts = 0;
      windowStart = time;
    }
    if (attempts >= max) {
      return { allowed: false, attempt: attempts, delayMs: 0, exhausted: true };
    }
    attempts++;
    const delayMs = Math.min(maxMs, baseMs * Math.pow(2, attempts - 1));
    return { allowed: true, attempt: attempts, delayMs, exhausted: false };
  }

  function ok() {
    attempts = 0;
    windowStart = null;
  }

  return {
    fail,
    ok,
    get attempts() { return attempts; },
    get max() { return max; }
  };
}

module.exports = { createRestartPolicy };
