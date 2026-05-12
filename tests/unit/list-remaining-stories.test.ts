import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import lsMod from '../../_Sprintpilot/scripts/list-remaining-stories.js';

const { parseStatuses, remainingFrom, stripQuotes, isDone } = lsMod as {
  parseStatuses: (raw: string) => Record<string, { status: string | null }>;
  remainingFrom: (m: Record<string, { status: string | null }>) => string[];
  stripQuotes: (s: string) => string;
  isDone: (s: string | null | undefined) => boolean;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'list-remaining-stories.js');

let tmpDir = '';
let tmpFile = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sp-ls-'));
  tmpFile = join(tmpDir, 'sprint-status.yaml');
});
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseStatuses', () => {
  it('extracts stories from canonical development_status block (2-space indent)', () => {
    const m = parseStatuses(`
sprint:
  name: "s"

epics:
  1:
    status: in-progress

development_status:
  1-1-a:
    status: ready-for-dev
  1-2-b:
    status: backlog
  1-3-c:
    status: done
`);
    expect(Object.keys(m).sort()).toEqual(['1-1-a', '1-2-b', '1-3-c']);
    expect(m['1-1-a'].status).toBe('ready-for-dev');
    expect(m['1-3-c'].status).toBe('done');
  });

  it('extracts stories from 4-space indent', () => {
    const m = parseStatuses(`
development_status:
    1-1-a:
        status: ready-for-dev
    1-2-b:
        status: done
`);
    expect(Object.keys(m).sort()).toEqual(['1-1-a', '1-2-b']);
    expect(m['1-2-b'].status).toBe('done');
  });

  it('extracts stories from tab indent', () => {
    const raw = `development_status:\n\t1-1-a:\n\t\tstatus: done\n`;
    const m = parseStatuses(raw);
    expect(m['1-1-a']?.status).toBe('done');
  });

  it('extracts from alternate `stories:` block', () => {
    const m = parseStatuses(`
stories:
  1-1:
    status: ready-for-dev
  1-2:
    status: done
`);
    expect(Object.keys(m).sort()).toEqual(['1-1', '1-2']);
  });

  it('handles inline form `key: status`', () => {
    const m = parseStatuses(`
development_status:
  1-1: done
  1-2: ready-for-dev
`);
    expect(m['1-1'].status).toBe('done');
    expect(m['1-2'].status).toBe('ready-for-dev');
  });

  it('handles quoted keys (double and single)', () => {
    const m = parseStatuses(`
development_status:
  "1-1-a":
    status: done
  '1-2-b':
    status: ready-for-dev
`);
    expect(Object.keys(m).sort()).toEqual(['1-1-a', '1-2-b']);
    expect(m['1-1-a'].status).toBe('done');
    expect(m['1-2-b'].status).toBe('ready-for-dev');
  });

  it('handles list-form with explicit id field', () => {
    const m = parseStatuses(`
development_status:
  - id: "1-1-a"
    status: done
  - id: "1-2-b"
    status: ready-for-dev
`);
    expect(Object.keys(m).sort()).toEqual(['1-1-a', '1-2-b']);
    expect(m['1-1-a'].status).toBe('done');
    expect(m['1-2-b'].status).toBe('ready-for-dev');
  });

  it('handles list-form with `key:` field (alternate id naming)', () => {
    const m = parseStatuses(`
stories:
  - key: 1-1-a
    status: done
  - key: 1-2-b
    status: backlog
`);
    expect(Object.keys(m).sort()).toEqual(['1-1-a', '1-2-b']);
    expect(m['1-1-a'].status).toBe('done');
  });

  it('handles list-form inline (`- key: status`)', () => {
    const m = parseStatuses(`
development_status:
  - 1-1-a: done
  - 1-2-b: ready-for-dev
`);
    expect(m['1-1-a'].status).toBe('done');
    expect(m['1-2-b'].status).toBe('ready-for-dev');
  });

  it('treats status comparison as case-insensitive', () => {
    const m = parseStatuses(`
development_status:
  1-1: Done
  1-2: DONE
  1-3: "done "
  1-4: ready-for-dev
`);
    expect(isDone(m['1-1'].status)).toBe(true);
    expect(isDone(m['1-2'].status)).toBe(true);
    expect(isDone(m['1-3'].status)).toBe(true);
    expect(isDone(m['1-4'].status)).toBe(false);
  });

  it('ignores epic entries even when they look like story keys', () => {
    const m = parseStatuses(`
epics:
  1:
    status: in-progress
development_status:
  1-1-a:
    status: backlog
`);
    expect(Object.keys(m)).toEqual(['1-1-a']);
  });

  it('handles missing development_status block', () => {
    const m = parseStatuses(`sprint:\n  name: "x"\n`);
    expect(m).toEqual({});
  });

  it('strips inline comments from status values', () => {
    const m = parseStatuses(`
development_status:
  1-1: done  # already shipped
  1-2:
    status: ready-for-dev   # awaiting dev
`);
    expect(m['1-1'].status).toBe('done');
    expect(m['1-2'].status).toBe('ready-for-dev');
  });
});

describe('stripQuotes', () => {
  it('strips matching double/single quotes', () => {
    expect(stripQuotes('"done"')).toBe('done');
    expect(stripQuotes("'done'")).toBe('done');
  });
  it('trims inner whitespace after unquoting', () => {
    expect(stripQuotes('"done "')).toBe('done');
    expect(stripQuotes("' done '")).toBe('done');
  });
  it('leaves unquoted values alone (trimmed)', () => {
    expect(stripQuotes('done')).toBe('done');
    expect(stripQuotes('  done  ')).toBe('done');
  });
});

describe('isDone', () => {
  it('treats "done" variants as done regardless of case/whitespace', () => {
    expect(isDone('done')).toBe(true);
    expect(isDone('Done')).toBe(true);
    expect(isDone('DONE')).toBe(true);
    expect(isDone(' done ')).toBe(true);
  });
  it('treats every other value as not done', () => {
    expect(isDone('ready-for-dev')).toBe(false);
    expect(isDone('')).toBe(false);
    expect(isDone(null)).toBe(false);
    expect(isDone(undefined)).toBe(false);
    expect(isDone('donex')).toBe(false);
  });
});

describe('remainingFrom', () => {
  it('returns only non-done keys', () => {
    expect(
      remainingFrom({
        a: { status: 'done' },
        b: { status: 'backlog' },
        c: { status: 'ready-for-dev' },
        d: { status: null },
      }).sort(),
    ).toEqual(['b', 'c', 'd']);
  });
  it('treats "Done" as done (case-insensitive)', () => {
    expect(
      remainingFrom({
        a: { status: 'Done' },
        b: { status: 'DONE' },
        c: { status: 'backlog' },
      }),
    ).toEqual(['c']);
  });
});

describe('CLI integration', () => {
  it('exits 0 + JSON array for a normal status file', () => {
    writeFileSync(
      tmpFile,
      `development_status:\n  1-1-a:\n    status: ready-for-dev\n  1-2-b:\n    status: done\n`,
    );
    const out = execFileSync(process.execPath, [SCRIPT, '--status-file', tmpFile]).toString();
    expect(JSON.parse(out)).toEqual(['1-1-a']);
  });

  it('exits 2 when the status file is missing (pre-planning signal)', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--status-file', tmpFile], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stdout.trim()).toBe('[]');
  });

  it('supports --format lines', () => {
    writeFileSync(
      tmpFile,
      `development_status:\n  a:\n    status: ready-for-dev\n  b:\n    status: backlog\n`,
    );
    const out = execFileSync(process.execPath, [
      SCRIPT,
      '--status-file',
      tmpFile,
      '--format',
      'lines',
    ]).toString();
    expect(out.trim().split('\n').sort()).toEqual(['a', 'b']);
  });

  it('emits an envelope with state=sprint-in-progress', () => {
    writeFileSync(
      tmpFile,
      `development_status:\n  1-1-a:\n    status: ready-for-dev\n  1-2-b:\n    status: done\n`,
    );
    const out = execFileSync(process.execPath, [
      SCRIPT,
      '--status-file',
      tmpFile,
      '--format',
      'envelope',
    ]).toString();
    const env = JSON.parse(out);
    expect(env.remaining).toEqual(['1-1-a']);
    expect(env.state).toBe('sprint-in-progress');
  });

  it('envelope: state=sprint-complete when everything is done', () => {
    writeFileSync(tmpFile, `development_status:\n  1-1-a:\n    status: done\n  1-2-b: Done\n`);
    const out = execFileSync(process.execPath, [
      SCRIPT,
      '--status-file',
      tmpFile,
      '--format',
      'envelope',
    ]).toString();
    const env = JSON.parse(out);
    expect(env.remaining).toEqual([]);
    expect(env.state).toBe('sprint-complete');
  });

  it('envelope: state=pre-planning on missing file (still emits valid JSON)', () => {
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '--status-file', tmpFile, '--format', 'envelope'],
      { encoding: 'utf8' },
    );
    expect(res.status).toBe(2);
    const env = JSON.parse(res.stdout);
    expect(env.state).toBe('pre-planning');
    expect(env.remaining).toEqual([]);
  });

  it('envelope: state=pre-planning when status file exists but is empty of stories', () => {
    writeFileSync(tmpFile, `sprint:\n  name: "s"\n`);
    const out = execFileSync(process.execPath, [
      SCRIPT,
      '--status-file',
      tmpFile,
      '--format',
      'envelope',
    ]).toString();
    const env = JSON.parse(out);
    expect(env.state).toBe('pre-planning');
    expect(env.remaining).toEqual([]);
  });
});
