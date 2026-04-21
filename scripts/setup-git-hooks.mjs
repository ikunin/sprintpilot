#!/usr/bin/env node
// Enables the repo-committed pre-push hook on `npm install`.
// Safe to run in any context:
//   - No-op when there is no .git directory (e.g. when users install this
//     package as a dependency via `npx @ikunin/sprintpilot`).
//   - No-op when core.hooksPath is already pointing at .githooks.
//   - Never fails the install on any error (git missing, permission denied,
//     read-only fs, etc.) — the hook is a developer convenience, not a
//     product requirement, so a failure here must not block `npm install`.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function exit(msg) {
  if (msg) console.log(`setup-git-hooks: ${msg}`);
  process.exit(0);
}

if (!existsSync('.git')) exit(); // not a clone, or running as a dep

try {
  const current = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
  if (current === '.githooks') exit('hooks already enabled (.githooks)');
} catch {
  // `git config --get` exits non-zero when the key is unset — that's
  // expected on a fresh clone. Fall through and set it.
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  console.log('setup-git-hooks: enabled .githooks/ (pre-push mirrors CI)');
} catch {
  // Any error here (permission denied, git missing, etc.) is non-fatal —
  // devs can set it manually: `git config core.hooksPath .githooks`
}
