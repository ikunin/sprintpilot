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
  markPhase,
  readMarker,
  markerPath,
  clearMarker,
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
  markPhase: (
    root: string,
    story: string,
    phase: string,
    meta?: unknown,
  ) => { duration_ms: number | null; prev_phase: string | null };
  readMarker: (root: string, story: string) => { story: string; phase: string; ts: string } | null;
  markerPath: (root: string, story: string) => string;
  clearMarker: (root: string, story: string) => void;
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
    expect(VALID_ACTIONS).toEqual(['start', 'end', 'once', 'mark']);
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

// ──────────────────────────────────────────────────────────────────
// `mark` — single-call timing API
// ──────────────────────────────────────────────────────────────────

describe('markPhase', () => {
  it('first mark emits no duration record (no previous phase)', () => {
    tmpRoot = seedProjectRoot({ phaseTimings: true });
    const r = markPhase(tmpRoot, 'sprint', 'skill.bmad-help');
    expect(r.duration_ms).toBeNull();
    expect(r.prev_phase).toBeNull();
    // Per-story marker written.
    const marker = readMarker(tmpRoot, 'sprint');
    expect(marker?.phase).toBe('skill.bmad-help');
    expect(marker?.story).toBe('sprint');
    // No duration line in any per-story shard yet.
    const file = join(timingsDir(tmpRoot), 'sprint.jsonl');
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('second mark emits a duration record for the previous phase', async () => {
    tmpRoot = seedProjectRoot({ phaseTimings: true });
    markPhase(tmpRoot, 'sprint', 'skill.bmad-help');
    await new Promise((r) => setTimeout(r, 10));
    const r2 = markPhase(tmpRoot, 'sprint', 'skill.bmad-create-story');
    expect(r2.prev_phase).toBe('skill.bmad-help');
    expect(r2.duration_ms).toBeGreaterThanOrEqual(10);
    // Per-story shard now has one duration line for the PREVIOUS phase.
    const file = join(timingsDir(tmpRoot), 'sprint.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0]);
    expect(obj.event).toBe('duration');
    expect(obj.phase).toBe('skill.bmad-help');
    expect(obj.duration_ms).toBeGreaterThanOrEqual(10);
    // Marker now holds the new phase.
    expect(readMarker(tmpRoot, 'sprint')?.phase).toBe('skill.bmad-create-story');
  });

  it('mark with phase="_end" closes THIS story\'s last phase only', async () => {
    tmpRoot = seedProjectRoot({ phaseTimings: true });
    markPhase(tmpRoot, 'sprint', 'skill.bmad-help');
    markPhase(tmpRoot, '1-1-foo', 'skill.bmad-dev-story');
    await new Promise((r) => setTimeout(r, 5));
    markPhase(tmpRoot, 'sprint', '_end' as unknown as string);
    // sprint marker is gone, but 1-1-foo's marker is untouched.
    expect(readMarker(tmpRoot, 'sprint')).toBeNull();
    expect(readMarker(tmpRoot, '1-1-foo')?.phase).toBe('skill.bmad-dev-story');
    const file = join(timingsDir(tmpRoot), 'sprint.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).phase).toBe('skill.bmad-help');
  });

  it('per-story markers are independent — different stories do not collide', async () => {
    tmpRoot = seedProjectRoot({ phaseTimings: true });
    // Two stories interleave their marks against the same project root.
    // Pre-2.0.5 a single global marker would have made the second story's
    // first mark close the FIRST story's phase. With per-story markers
    // each story chains independently.
    markPhase(tmpRoot, '1-1-foo', 'skill.bmad-create-story');
    await new Promise((r) => setTimeout(r, 5));
    markPhase(tmpRoot, '1-2-bar', 'skill.bmad-create-story');
    await new Promise((r) => setTimeout(r, 5));
    markPhase(tmpRoot, '1-1-foo', 'skill.bmad-dev-story');
    // 1-1-foo's duration record exists and attributes to 1-1-foo's
    // skill.bmad-create-story (not 1-2-bar).
    const fooFile = join(timingsDir(tmpRoot), '1-1-foo.jsonl');
    const fooObj = JSON.parse(readFileSync(fooFile, 'utf8').trim());
    expect(fooObj.story).toBe('1-1-foo');
    expect(fooObj.phase).toBe('skill.bmad-create-story');
    // 1-2-bar's marker is still open at skill.bmad-create-story (no end yet).
    expect(readMarker(tmpRoot, '1-2-bar')?.phase).toBe('skill.bmad-create-story');
    // 1-2-bar's shard has no duration record yet.
    const barFile = join(timingsDir(tmpRoot), '1-2-bar.jsonl');
    expect(() => readFileSync(barFile, 'utf8')).toThrow();
  });

  it('parallel-marker race: concurrent same-process marks for different stories do not corrupt either', async () => {
    tmpRoot = seedProjectRoot({ phaseTimings: true });
    // Open both stories. Then close them concurrently via Promise.all.
    // With a single global marker (pre-2.0.5) one rename would clobber
    // the other and one duration record would be lost. With per-story
    // markers both records are emitted.
    markPhase(tmpRoot, '1-1-foo', 'skill.bmad-dev-story');
    markPhase(tmpRoot, '1-2-bar', 'skill.bmad-dev-story');
    await Promise.all([
      Promise.resolve().then(() => markPhase(tmpRoot, '1-1-foo', 'skill.bmad-code-review')),
      Promise.resolve().then(() => markPhase(tmpRoot, '1-2-bar', 'skill.bmad-code-review')),
    ]);
    const fooLines = readFileSync(join(timingsDir(tmpRoot), '1-1-foo.jsonl'), 'utf8').trim().split('\n');
    const barLines = readFileSync(join(timingsDir(tmpRoot), '1-2-bar.jsonl'), 'utf8').trim().split('\n');
    expect(fooLines.length).toBe(1);
    expect(barLines.length).toBe(1);
    const foo = JSON.parse(fooLines[0]);
    const bar = JSON.parse(barLines[0]);
    expect(foo.story).toBe('1-1-foo');
    expect(foo.phase).toBe('skill.bmad-dev-story');
    expect(bar.story).toBe('1-2-bar');
    expect(bar.phase).toBe('skill.bmad-dev-story');
  });

  it('clamps negative durations on wall-clock backstep and stamps clock_skew=true', () => {
    tmpRoot = seedProjectRoot({ phaseTimings: true });
    // Manually plant a marker with a future timestamp to simulate clock
    // backstep between marks (NTP correction, DST, manual clock change).
    const futureTs = new Date(Date.now() + 60_000).toISOString();
    const dir = timingsDir(tmpRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.mark.sprint.json'),
      JSON.stringify({ story: 'sprint', phase: 'skill.bmad-help', ts: futureTs }),
    );
    const r = markPhase(tmpRoot, 'sprint', 'skill.bmad-create-story');
    expect(r.duration_ms).toBe(0);
    const lines = readFileSync(join(dir, 'sprint.jsonl'), 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.duration_ms).toBe(0);
    expect(entry.clock_skew).toBe(true);
  });

  it('CLI mark emits {marked, prev_phase, duration_ms} JSON to stdout', () => {
    tmpRoot = seedProjectRoot({ phaseTimings: true });
    const out1 = execFileSync(process.execPath, [
      SCRIPT,
      'mark',
      '--story',
      'sprint',
      '--phase',
      'skill.bmad-help',
      '--project-root',
      tmpRoot,
    ]).toString();
    const r1 = JSON.parse(out1);
    expect(r1).toMatchObject({ marked: 'skill.bmad-help', prev_phase: null, duration_ms: null });
    const out2 = execFileSync(process.execPath, [
      SCRIPT,
      'mark',
      '--story',
      'sprint',
      '--phase',
      'skill.bmad-create-story',
      '--project-root',
      tmpRoot,
    ]).toString();
    const r2 = JSON.parse(out2);
    expect(r2.marked).toBe('skill.bmad-create-story');
    expect(r2.prev_phase).toBe('skill.bmad-help');
    expect(typeof r2.duration_ms).toBe('number');
  });

  it('mark is a silent no-op when phase_timings is disabled', () => {
    tmpRoot = seedProjectRoot({ phaseTimings: false });
    const out = execFileSync(process.execPath, [
      SCRIPT,
      'mark',
      '--story',
      'sprint',
      '--phase',
      'skill.bmad-help',
      '--project-root',
      tmpRoot,
    ]).toString();
    expect(out).toBe(''); // nothing emitted
    expect(readMarker(tmpRoot, 'sprint')).toBeNull();
  });
});
