// Regression test for the v2.1.0 ship bug where `_Sprintpilot/bin/` was added
// to the repo but never to `RUNTIME_RESOURCES` in `lib/commands/install.js`.
// Result: published package had `bin/autopilot.js`, but the installer skipped
// it, leaving upgraders without the orchestrator CLI the new workflow needs.
//
// Rule: every top-level item under `_Sprintpilot/` that ships code or config
// MUST be either (a) listed in `RUNTIME_RESOURCES`, or (b) `skills/` (which is
// copied separately by the per-tool loop), or (c) `sprints/` (runtime-created
// scratch dir, not bundled), or (d) hidden files we already enumerate
// explicitly (`.secrets-allowlist`).

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import installMod from '../../lib/commands/install.js';

const { _internals } = installMod as {
  _internals: { RUNTIME_RESOURCES: readonly string[] };
};

const ADDON_ROOT = join(__dirname, '..', '..', '_Sprintpilot');

// Items the installer handles outside of RUNTIME_RESOURCES, or that are
// runtime-only (created by scripts, not bundled).
const HANDLED_ELSEWHERE = new Set([
  'skills', // copied by the per-tool loop in runInstall
  'sprints', // created at runtime by infer-dependencies.js
  '_bmad-output', // BMad-owned runtime artifact dir (created by BMad skills, never bundled)
]);

describe('RUNTIME_RESOURCES covers every shipped _Sprintpilot/ subdir', () => {
  it('every top-level entry under _Sprintpilot/ is either in RUNTIME_RESOURCES or HANDLED_ELSEWHERE', () => {
    const entries = readdirSync(ADDON_ROOT);
    const covered = new Set([..._internals.RUNTIME_RESOURCES, ...HANDLED_ELSEWHERE]);
    const missing: string[] = [];
    for (const name of entries) {
      // Skip OS junk and editor files
      if (name.startsWith('.DS_Store')) continue;
      if (name.endsWith('~')) continue;
      // The `.secrets-allowlist` dotfile is in RUNTIME_RESOURCES explicitly.
      if (!covered.has(name)) {
        const full = join(ADDON_ROOT, name);
        const isDir = statSync(full).isDirectory();
        // Files that aren't handled are a problem; empty dirs aren't.
        if (isDir) {
          // Only flag dirs that actually contain something shippable.
          const children = readdirSync(full);
          if (children.length > 0) missing.push(`${name}/`);
        } else {
          missing.push(name);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('RUNTIME_RESOURCES includes the orchestrator CLI directory (bin/)', () => {
    // Direct assertion of the specific regression — independent of the
    // dynamic scan above so the failure message is obvious.
    expect(_internals.RUNTIME_RESOURCES).toContain('bin');
  });
});
