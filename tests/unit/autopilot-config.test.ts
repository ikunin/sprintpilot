import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import installMod from '../../lib/commands/install.js';

type V1Snapshot = Record<string, Array<{ relPath: string; buffer: Buffer }>>;

const { _internals } = installMod as {
  _internals: {
    readExistingAutopilotConfig: (
      root: string,
      v1Snapshot?: V1Snapshot,
    ) => Promise<{
      sessionStoryLimit: number | null;
      retrospectiveMode: string | null;
    }>;
    patchAutopilotConfig: (
      root: string,
      opts: { sessionStoryLimit: number; retrospectiveMode: string },
    ) => Promise<void>;
    applyScalar: (source: string, key: string, value: string | number) => string;
    RETROSPECTIVE_MODES: readonly string[];
  };
};

const { readExistingAutopilotConfig, patchAutopilotConfig, applyScalar, RETROSPECTIVE_MODES } =
  _internals;

let root: string;

function writeConfig(contents: string): void {
  const dir = join(root, '_Sprintpilot', 'modules', 'autopilot');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), contents, 'utf8');
}

function readConfig(): string {
  return readFileSync(join(root, '_Sprintpilot', 'modules', 'autopilot', 'config.yaml'), 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-autopilot-config-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readExistingAutopilotConfig', () => {
  it('returns nulls when the config file is absent', async () => {
    const out = await readExistingAutopilotConfig(root);
    expect(out).toEqual({ sessionStoryLimit: null, retrospectiveMode: null });
  });

  it('parses the plain canonical shape', async () => {
    writeConfig(`autopilot:\n  session_story_limit: 5\n  retrospective_mode: stop\n`);
    const out = await readExistingAutopilotConfig(root);
    expect(out).toEqual({ sessionStoryLimit: 5, retrospectiveMode: 'stop' });
  });

  it('tolerates inline trailing comments (P1-A fix)', async () => {
    writeConfig(
      `autopilot:\n  session_story_limit: 7  # two sprints per session\n  retrospective_mode: skip  # inline or pause\n`,
    );
    const out = await readExistingAutopilotConfig(root);
    expect(out).toEqual({ sessionStoryLimit: 7, retrospectiveMode: 'skip' });
  });

  it('accepts quoted retrospective_mode values', async () => {
    writeConfig(`autopilot:\n  retrospective_mode: "auto"\n`);
    const out = await readExistingAutopilotConfig(root);
    expect(out.retrospectiveMode).toBe('auto');
  });

  it('rejects unknown retrospective_mode values (returns null to force re-prompt)', async () => {
    writeConfig(`autopilot:\n  retrospective_mode: bogus\n`);
    const out = await readExistingAutopilotConfig(root);
    expect(out.retrospectiveMode).toBe(null);
  });

  it('skips commented-out key lines (no match)', async () => {
    writeConfig(`autopilot:\n  # session_story_limit: 99\n  # retrospective_mode: skip\n`);
    const out = await readExistingAutopilotConfig(root);
    expect(out).toEqual({ sessionStoryLimit: null, retrospectiveMode: null });
  });

  it('falls back to the v1 in-memory snapshot when no file on disk (v1-migration bug)', async () => {
    // evictV1Installation removes `_bmad-addons/` BEFORE resolveAutopilotSettings
    // runs, so by the time we try to read the user's v1 config, only the
    // in-memory snapshot still has it. Without this path the patcher overwrites
    // the user's edited `session_story_limit: 5` with the bundled default `3`.
    const v1Snapshot = {
      autopilot: [
        {
          relPath: 'config.yaml',
          buffer: Buffer.from('autopilot:\n  session_story_limit: 5  # user-edited\n', 'utf8'),
        },
      ],
    };
    const out = await readExistingAutopilotConfig(root, v1Snapshot);
    expect(out.sessionStoryLimit).toBe(5);
    expect(out.retrospectiveMode).toBe(null);
  });

  it('v1 in-memory snapshot is ignored when config.yaml already exists on disk', async () => {
    // On-disk file wins over snapshot so a fresh Sprintpilot upgrade (not
    // a v1 migration) reads the user's current Sprintpilot config.
    writeConfig(`autopilot:\n  session_story_limit: 8\n  retrospective_mode: stop\n`);
    const v1Snapshot = {
      autopilot: [
        { relPath: 'config.yaml', buffer: Buffer.from('autopilot:\n  session_story_limit: 99\n') },
      ],
    };
    const out = await readExistingAutopilotConfig(root, v1Snapshot);
    expect(out.sessionStoryLimit).toBe(8);
    expect(out.retrospectiveMode).toBe('stop');
  });

  it('exposes the known mode whitelist', () => {
    expect(RETROSPECTIVE_MODES).toEqual(['auto', 'stop', 'skip']);
  });
});

describe('applyScalar', () => {
  it('replaces an existing value', () => {
    const out = applyScalar('autopilot:\n  session_story_limit: 3\n', 'session_story_limit', 7);
    expect(out).toBe('autopilot:\n  session_story_limit: 7\n');
  });

  it('preserves an inline trailing comment when replacing', () => {
    const out = applyScalar(
      'autopilot:\n  retrospective_mode: auto  # keep human in loop\n',
      'retrospective_mode',
      'stop',
    );
    expect(out).toBe('autopilot:\n  retrospective_mode: stop  # keep human in loop\n');
  });

  it('fills in an empty value (P1-C)', () => {
    const out = applyScalar('autopilot:\n  session_story_limit:\n', 'session_story_limit', 4);
    expect(out).toBe('autopilot:\n  session_story_limit: 4\n');
  });

  it('appends the key under the `autopilot:` block when missing (P1-B)', () => {
    const out = applyScalar('autopilot:\n  session_story_limit: 3\n', 'retrospective_mode', 'stop');
    expect(out).toBe('autopilot:\n  session_story_limit: 3\n  retrospective_mode: stop\n');
  });

  it('adds a trailing newline before appending if the source lacks one', () => {
    const out = applyScalar('autopilot:\n  session_story_limit: 3', 'retrospective_mode', 'auto');
    expect(out.endsWith('  retrospective_mode: auto\n')).toBe(true);
    expect(out.includes('\n\n')).toBe(false);
  });

  it('bails (returns input) when the file has no `autopilot:` header', () => {
    const input = '# empty or hand-edited config\nsome_other: thing\n';
    expect(applyScalar(input, 'retrospective_mode', 'auto')).toBe(input);
  });
});

describe('patchAutopilotConfig', () => {
  it('noop when the config file is absent', async () => {
    await expect(
      patchAutopilotConfig(root, { sessionStoryLimit: 3, retrospectiveMode: 'auto' }),
    ).resolves.toBeUndefined();
  });

  it('rewrites both keys in place', async () => {
    writeConfig(`autopilot:\n  session_story_limit: 3\n  retrospective_mode: auto\n`);
    await patchAutopilotConfig(root, { sessionStoryLimit: 10, retrospectiveMode: 'stop' });
    const raw = readConfig();
    expect(raw).toContain('  session_story_limit: 10');
    expect(raw).toContain('  retrospective_mode: stop');
  });

  it('appends retrospective_mode on v1-style upgrade configs that lack it (P1-B)', async () => {
    // Simulates the legacy bmad-autopilot-addon config.yaml snapshot that
    // gets re-applied after Sprintpilot's bundled defaults land. Without the
    // append branch, the user's prompted choice is silently dropped.
    writeConfig(`# bmad-autopilot-addon v1 config\nautopilot:\n  session_story_limit: 2\n`);
    await patchAutopilotConfig(root, { sessionStoryLimit: 2, retrospectiveMode: 'stop' });
    const raw = readConfig();
    expect(raw).toContain('  session_story_limit: 2');
    expect(raw).toContain('  retrospective_mode: stop');
  });

  it('preserves trailing comments on replaced values', async () => {
    writeConfig(
      `autopilot:\n  session_story_limit: 3  # matches our sprint length\n  retrospective_mode: auto\n`,
    );
    await patchAutopilotConfig(root, { sessionStoryLimit: 5, retrospectiveMode: 'skip' });
    const raw = readConfig();
    expect(raw).toContain('session_story_limit: 5  # matches our sprint length');
    expect(raw).toContain('retrospective_mode: skip');
  });
});
