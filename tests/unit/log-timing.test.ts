import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import logTimingMod from '../../_Sprintpilot/scripts/log-timing.js';

const {
  STORY_RE,
  PHASE_RE,
  META_MAX_BYTES,
  LINE_MAX_BYTES,
  VALID_ACTIONS,
  validateStory,
  validatePhase,
  validateAction,
  validateMeta,
  timingsDir,
  readPhaseTimingSetting,
  isEnabled,
  appendLine,
  buildEntry,
} = logTimingMod as {
  STORY_RE: RegExp;
  PHASE_RE: RegExp;
  META_MAX_BYTES: number;
  LINE_MAX_BYTES: number;
  VALID_ACTIONS: string[];
  validateStory: (s: unknown) => { ok: boolean; value?: string; error?: string };
  validatePhase: (s: unknown) => { ok: boolean; value?: string; error?: string };
  validateAction: (s: unknown) => { ok: boolean; value?: string; error?: string };
  validateMeta: (s: unknown) => { ok: boolean; value?: unknown; error?: string };
  timingsDir: (root: string) => string;
  readPhaseTimingSetting: (root: string) => boolean;
  isEnabled: (root: string) => boolean;
  appendLine: (root: string, story: string, entry: Record<string, unknown>) => string;
  buildEntry: (
    action: string,
    story: string,
    phase: string,
    meta?: unknown,
  ) => Record<string, unknown>;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'log-timing.js');

let tmpRoot = '';

function seedProjectRoot(opts: { phaseTimings?: boolean; profile?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-log-timing-'));
  const profilesSrc = join(REPO_ROOT, '_Sprintpilot', 'modules', 'autopilot', 'profiles');
  const profilesDest = join(root, '_Sprintpilot', 'modules', 'autopilot', 'profiles');
  mkdirSync(profilesDest, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  for (const entry of fs.readdirSync(profilesSrc)) {
    fs.copyFileSync(join(profilesSrc, entry), join(profilesDest, entry));
  }
  const cfgDir = join(root, '_Sprintpilot', 'modules', 'autopilot');
  mkdirSync(cfgDir, { recursive: true });
  const lines: string[] = [];
  if (opts.profile) lines.push(`complexity_profile: ${opts.profile}`);
  if (opts.phaseTimings !== undefined) lines.push(`phase_timings: ${opts.phaseTimings}`);
  writeFileSync(join(cfgDir, 'config.yaml'), `${lines.join('\n')}\n`, 'utf8');
  return root;
}

beforeEach(() => {
  tmpRoot = '';
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('constants', () => {
  it('exposes canonical actions and regexes', () => {
    expect(VALID_ACTIONS).toEqual(['start', 'end', 'once']);
    expect(STORY_RE.source).toBe('^[a-z0-9][a-z0-9-]*$');
    expect(PHASE_RE.source).toBe('^[a-z][a-z0-9-.]*$');
    expect(META_MAX_BYTES).toBe(2048);
    expect(LINE_MAX_BYTES).toBe(4096);
  });
});

describe('validateStory', () => {
  it('accepts canonical story keys', () => {
    expect(validateStory('1-2-user-authentication').ok).toBe(true);
    expect(validateStory('a').ok).toBe(true);
    expect(validateStory('7-3-fix-login-bug-42').ok).toBe(true);
  });
  it('rejects path-traversal attempts and other shell-significant chars', () => {
    expect(validateStory('../etc/passwd').ok).toBe(false);
    expect(validateStory('a/b').ok).toBe(false);
    expect(validateStory('a.b').ok).toBe(false);
    expect(validateStory('a b').ok).toBe(false);
    expect(validateStory('A-UPPER').ok).toBe(false);
    expect(validateStory('-leading-dash').ok).toBe(false);
  });
  it('rejects empty/undefined', () => {
    expect(validateStory('').ok).toBe(false);
    expect(validateStory(undefined).ok).toBe(false);
  });
});

describe('validatePhase', () => {
  it('accepts dotted namespaces', () => {
    expect(validatePhase('skill.bmad-dev-story').ok).toBe(true);
    expect(validatePhase('boot.health-check').ok).toBe(true);
    expect(validatePhase('git.pr-create').ok).toBe(true);
  });
  it('rejects bad shapes', () => {
    expect(validatePhase('Upper').ok).toBe(false);
    expect(validatePhase('.leading-dot').ok).toBe(false);
    expect(validatePhase('trailing space ').ok).toBe(false);
    expect(validatePhase('has/slash').ok).toBe(false);
  });
});

describe('validateAction', () => {
  it('accepts start/end/once', () => {
    expect(validateAction('start').ok).toBe(true);
    expect(validateAction('end').ok).toBe(true);
    expect(validateAction('once').ok).toBe(true);
  });
  it('rejects unknown actions', () => {
    expect(validateAction('begin').ok).toBe(false);
    expect(validateAction('').ok).toBe(false);
  });
});

describe('validateMeta', () => {
  it('accepts undefined (meta is optional)', () => {
    const out = validateMeta(undefined);
    expect(out.ok).toBe(true);
    expect(out.value).toBeUndefined();
  });
  it('accepts small JSON objects', () => {
    const out = validateMeta('{"k":"v","n":1}');
    expect(out.ok).toBe(true);
    expect(out.value).toEqual({ k: 'v', n: 1 });
  });
  it('rejects invalid JSON', () => {
    expect(validateMeta('{not json').ok).toBe(false);
  });
  it('rejects oversized payloads', () => {
    const big = JSON.stringify({ blob: 'x'.repeat(META_MAX_BYTES) });
    expect(validateMeta(big).ok).toBe(false);
  });
});

describe('readPhaseTimingSetting', () => {
  it('defaults to false when nothing is configured (fail-safe)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sp-empty-'));
    expect(readPhaseTimingSetting(empty)).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });
  it('honors explicit true in autopilot/config.yaml', () => {
    tmpRoot = seedProjectRoot({ phaseTimings: true });
    expect(readPhaseTimingSetting(tmpRoot)).toBe(true);
    expect(isEnabled(tmpRoot)).toBe(true);
  });
  it('honors explicit false in autopilot/config.yaml', () => {
    tmpRoot = seedProjectRoot({ phaseTimings: false, profile: 'medium' });
    expect(readPhaseTimingSetting(tmpRoot)).toBe(false);
    expect(isEnabled(tmpRoot)).toBe(false);
  });
  it('falls back to profile value (legacy = false) when config is silent', () => {
    tmpRoot = seedProjectRoot({ profile: 'legacy' });
    expect(readPhaseTimingSetting(tmpRoot)).toBe(false);
  });
});

describe('appendLine + buildEntry', () => {
  it('creates the .timings directory and writes a JSONL line', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sp-append-'));
    const entry = buildEntry('start', '1-1-foo', 'skill.bmad-dev-story');
    const file = appendLine(tmpRoot, '1-1-foo', entry);
    expect(file.endsWith('1-1-foo.jsonl')).toBe(true);
    const raw = readFileSync(file, 'utf8');
    const obj = JSON.parse(raw.trim());
    expect(obj.event).toBe('start');
    expect(obj.story).toBe('1-1-foo');
    expect(obj.phase).toBe('skill.bmad-dev-story');
    expect(typeof obj.ts).toBe('string');
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  });
  it('throws when a single line would exceed PIPE_BUF (atomicity guard)', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sp-append-big-'));
    const huge = { blob: 'x'.repeat(LINE_MAX_BYTES + 100) };
    expect(() => appendLine(tmpRoot, 'big', { event: 'once', story: 'big', phase: 'p', ts: '2026-01-01T00:00:00.000Z', meta: huge })).toThrow(/exceeds/);
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  });
  it('appends without overwriting existing lines', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sp-append-multi-'));
    appendLine(tmpRoot, 'x', buildEntry('start', 'x', 'p'));
    appendLine(tmpRoot, 'x', buildEntry('end', 'x', 'p'));
    const raw = readFileSync(join(timingsDir(tmpRoot), 'x.jsonl'), 'utf8');
    expect(raw.trim().split('\n').length).toBe(2);
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  });
});

describe('CLI integration', () => {
  it('silently no-ops when phase_timings is disabled (exit 0, no file)', () => {
    tmpRoot = seedProjectRoot({ phaseTimings: false, profile: 'medium' });
    const res = spawnSync(
      process.execPath,
      [SCRIPT, 'start', '--story', '1-1', '--phase', 'skill.bmad-dev-story', '--project-root', tmpRoot],
      { encoding: 'utf8' },
    );
    expect(res.status).toBe(0);
    // Directory should not have been created by a no-op invocation.
    const dir = timingsDir(tmpRoot);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('writes a JSONL entry end-to-end when enabled', () => {
    tmpRoot = seedProjectRoot({ phaseTimings: true, profile: 'medium' });
    execFileSync(
      process.execPath,
      [SCRIPT, 'start', '--story', '2-1-foo', '--phase', 'skill.bmad-dev-story', '--project-root', tmpRoot],
      { encoding: 'utf8' },
    );
    const file = join(timingsDir(tmpRoot), '2-1-foo.jsonl');
    const line = readFileSync(file, 'utf8').trim();
    const obj = JSON.parse(line);
    expect(obj.event).toBe('start');
    expect(obj.story).toBe('2-1-foo');
    expect(obj.phase).toBe('skill.bmad-dev-story');
  });

  it('exits non-zero on bad input and writes nothing', () => {
    tmpRoot = seedProjectRoot({ phaseTimings: true });
    const res = spawnSync(
      process.execPath,
      [SCRIPT, 'start', '--story', '../etc/passwd', '--phase', 'skill.bmad-dev-story', '--project-root', tmpRoot],
      { encoding: 'utf8' },
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/invalid --story/);
  });

  it('is race-free under N parallel subprocess appends to the same shard', () => {
    tmpRoot = seedProjectRoot({ phaseTimings: true });
    const N = 24;
    const kids = [];
    for (let i = 0; i < N; i++) {
      kids.push(
        spawnSync(
          process.execPath,
          [
            SCRIPT,
            'once',
            '--story',
            'race',
            '--phase',
            'tests.parallel',
            '--meta',
            JSON.stringify({ i }),
            '--project-root',
            tmpRoot,
          ],
          { encoding: 'utf8' },
        ),
      );
    }
    for (const k of kids) expect(k.status).toBe(0);
    const file = join(timingsDir(tmpRoot), 'race.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(N);
    // Every line is parseable JSON and carries a unique meta.i.
    const seen = new Set<number>();
    for (const l of lines) {
      const obj = JSON.parse(l);
      expect(obj.event).toBe('once');
      seen.add(obj.meta.i);
    }
    expect(seen.size).toBe(N);
  });
});
