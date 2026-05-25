// generic adapter — last-resort fallback.
//
// Matches every project. Returns the user-supplied test command (if any).
// When no command is configured AND scope === 'affected', returns null
// so the scope resolver can fall back to 'full'.
//
// detect()             → always true
// buildCmd({...})      → string | null

'use strict';

const NAME = 'generic';

function detect() {
  return true;
}

function buildCmd({ scope, profile }) {
  if (!profile) return null;
  if (scope === 'full') return profile.testing_commands_full || 'npm test';
  // affected — only honor a user override; otherwise signal "no idea, fall
  // back to full" by returning null.
  return profile.testing_commands_affected || null;
}

module.exports = { NAME, detect, buildCmd };
