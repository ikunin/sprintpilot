import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import lsMod from '../../_Sprintpilot/scripts/list-remaining-stories.js';

const { parseStatuses, remainingFrom, stripQuotes } = lsMod as {
  parseStatuses: (raw: string) => Record<string, { status: string | null }>;
  remainingFrom: (m: Record<string, { status: string | null }>) => string[];
  stripQuotes: (s: string) => string;
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
  it('extracts stories from canonical development_status block', () => {
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
    expect(m['1-2-b'].status).toBe('backlog');
    expect(m['1-3-c'].status).toBe('done');
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
});

describe('stripQuotes', () => {
  it('strips matching double/single quotes', () => {
    expect(stripQuotes('"done"')).toBe('done');
    expect(stripQuotes("'done'")).toBe('done');
  });
  it('leaves unquoted values alone', () => {
    expect(stripQuotes('done')).toBe('done');
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
    const res = spawnSync(process.execPath, [SCRIPT, '--status-file', tmpFile], { encoding: 'utf8' });
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
});
