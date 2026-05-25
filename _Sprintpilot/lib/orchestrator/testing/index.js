// testing/index.js — adapter registry.
//
// pickAdapter(projectRoot) → adapter | null
//
// Probes adapters in priority order; first detect() match wins.
// Generic is always last and always matches, so this never returns
// null unless the project root is missing.

'use strict';

const vitest = require('./vitest');
const jest = require('./jest');
const pytest = require('./pytest');
const generic = require('./generic');

const ADAPTERS = [vitest, jest, pytest, generic];

function pickAdapter(projectRoot) {
  if (!projectRoot) return null;
  for (const a of ADAPTERS) {
    try {
      if (a.detect(projectRoot)) return a;
    } catch (_e) {
      // Detection should not throw; defensive skip.
    }
  }
  return null;
}

module.exports = {
  ADAPTERS,
  pickAdapter,
  // Exposed for unit tests + debugging.
  adapters: { vitest, jest, pytest, generic },
};
