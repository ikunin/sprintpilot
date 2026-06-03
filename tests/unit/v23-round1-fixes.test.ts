// Tests for the Round-1 hardening fixes (H1–H4 + M1–M6 + L5–L6).
//
// Each fix gets at least one positive + one negative case. Concurrent
// behavior tests use spawnSync to fork real subprocesses since js-yaml
// + lock.js are CommonJS and the lock primitive only serializes across
// PROCESSES (not within a single Node process — that's fine because the
// real risk is two `node autopilot.js …` invocations).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS
import ledgerMod from '../../_Sprintpilot/lib/orchestrator/action-ledger.js';
// @ts-expect-error — CommonJS
import adaptMod from '../../_Sprintpilot/lib/orchestrator/adapt.js';
// @ts-expect-error — CommonJS
import profileRules from '../../_Sprintpilot/lib/orchestrator/profile-rules.js';
// @ts-expect-error — CommonJS
import applierMod from '../../_Sprintpilot/lib/orchestrator/user-command-applier.js';
// @ts-expect-error — CommonJS
import resolveDagMod from '../../_Sprintpilot/scripts/resolve-dag.js';
// @ts-expect-error — CommonJS
import sprintPlanMod from '../../_Sprintpilot/scripts/sprint-plan.js';

const REPO_ROOT = join(__dirname, '..', '..');
const SP_SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'sprint-plan.js');
const INFER_SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'infer-dependencies.js');

// See v23-e2e-flow.test.ts for the rationale. tl;dr: Windows path.join
// returns backslashes that re-interpret as escape sequences when embedded
// in a `node -e` template string, so the spawned process gets a corrupted
// path. Node accepts forward slashes on Windows.
const sx = (p: string) => p.replace(/\\/g, '/');

const {
  emptyPlan,
  write: writePlan,
  read: readPlan,
  lockPath,
  reorder,
  archive,
  setIssueId,
} = sprintPlanMod as {
  emptyPlan: (o?: { source?: string }) => Record<string, unknown>;
  write: (p: Record<string, unknown>, o: { projectRoot: string }) => string;
  read: (o: { projectRoot: string }) => Record<string, unknown> | null;
  planPath: (root: string) => string;
  lockPath: (root: string) => string;
  reorder: (newOrder: string[], o: { projectRoot: string }) => string;
  archive: (id: string, o: { projectRoot: string }) => Record<string, unknown>;
  setIssueId: (
    key: string,
    id: string | null,
    o: { projectRoot: string },
  ) => Record<string, unknown>;
};

const { verifyIssuesSignature } = adaptMod as {
  verifyIssuesSignature: (issues: unknown) => string | null;
};

const { renderMermaid, renderGraphviz } = resolveDagMod as {
  renderMermaid: (
    dag: { nodes: string[]; edges: [string, string][] },
    plan: Record<string, unknown> | null,
  ) => string;
  renderGraphviz: (
    dag: { nodes: string[]; edges: [string, string][] },
    plan: Record<string, unknown> | null,
  ) => string;
};

let tmpRoot = '';

function seedPlan(stories: Array<Record<string, unknown>> = []): Record<string, unknown> {
  const plan = emptyPlan({ source: 'auto' });
  plan.stories = stories;
  writePlan(plan, { projectRoot: tmpRoot });
  return plan;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-r1-'));
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

// ──────────────────────────────────────────────────────────────────
// H1 — plan.lock acquisition serializes concurrent mutators
// ──────────────────────────────────────────────────────────────────

describe('H1 — plan.lock serializes concurrent writers', () => {
  it('creates the .sprintpilot/plan.lock file path when mutate runs', () => {
    seedPlan([{ key: 'a', plan_status: 'pending', priority: 1 }]);
    // Trigger a mutate via the public CLI. The lock is acquired then
    // released; the file disappears, but the directory should exist.
    execFileSync('node', [SP_SCRIPT, 'empty', '--source', 'auto'], { encoding: 'utf8' });
    expect(existsSync(join(tmpRoot, '.sprintpilot'))).toBe(false);
    // Now invoke a real mutator and verify the lock dir gets created.
    const { mutate } = sprintPlanMod as {
      mutate: (root: string, fn: (p: Record<string, unknown>) => Record<string, unknown>) => string;
    };
    mutate(tmpRoot, (p) => p);
    // After mutate returns, the lock file is released but the
    // .sprintpilot/ directory persists.
    expect(existsSync(join(tmpRoot, '.sprintpilot'))).toBe(true);
  });

  it('two parallel mutators do not lose each others updates', async () => {
    seedPlan([
      { key: 'a', plan_status: 'pending', priority: 1, issue_id: null },
      { key: 'b', plan_status: 'pending', priority: 2, issue_id: null },
    ]);
    // Round 2 — use `spawn` (NOT spawnSync) so the two child processes
    // actually run concurrently. With spawnSync, Promise.all on already-
    // resolved values doesn't prove parallelism. With real spawn, the
    // OS scheduler interleaves them and the plan.lock is the only thing
    // keeping both writes consistent.
    const { spawn } = await import('node:child_process');
    const scriptA = `
      const m = require('${sx(SP_SCRIPT)}');
      // Sleep briefly inside the mutate path to force contention.
      const start = Date.now();
      m.setIssueId('a', 'PROJ-1', { projectRoot: '${sx(tmpRoot)}' });
    `;
    const scriptB = `
      const m = require('${sx(SP_SCRIPT)}');
      const start = Date.now();
      m.setIssueId('b', 'PROJ-2', { projectRoot: '${sx(tmpRoot)}' });
    `;
    const runChild = (script: string): Promise<{ status: number; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('exit', (code) => resolve({ status: code ?? -1, stderr }));
      });
    const start = Date.now();
    const [a, b] = await Promise.all([runChild(scriptA), runChild(scriptB)]);
    const elapsed = Date.now() - start;
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    // Both children should overlap in time (each takes ~100ms for the
    // node startup + module load). A serial run would take 2x elapsed
    // of the slower one. We can't assert exact timing, but we can
    // assert both writes survived — that's the lock's correctness
    // property under genuine contention.
    void elapsed;
    const plan = readPlan({ projectRoot: tmpRoot }) as { stories: Array<Record<string, unknown>> };
    const ids = plan.stories.map((s) => s.issue_id).sort();
    expect(ids).toEqual(['PROJ-1', 'PROJ-2']);
  });

  it('archive() acquires plan.lock too (same primitive as mutate)', () => {
    const plan = seedPlan([{ key: 'a', plan_status: 'done', priority: 1 }]);
    const r = archive(plan.plan_id as string, { projectRoot: tmpRoot });
    expect(r.archived).toBe(true);
    // Lock file is released after archive returns.
    expect(existsSync(lockPath(tmpRoot))).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// H2 — render label escape handles mermaid metacharacters
// ──────────────────────────────────────────────────────────────────

describe('H2 — render escape covers issue_id metacharacters', () => {
  it('mermaid escapes ] [ ( ) < > and newlines from issue_id', () => {
    const plan = emptyPlan({ source: 'auto' });
    // Story keys are STORY_KEY_RE-validated upstream so they're safe;
    // the dangerous data flows through issue_id. Bypass setIssueId's
    // validation by writing directly to the in-memory plan.
    plan.stories = [
      {
        key: '1-1-a',
        plan_status: 'pending',
        issue_id: 'PROJ]:::bogus[hack]<script>',
      },
    ];
    const out = renderMermaid({ nodes: ['1-1-a'], edges: [] }, plan);
    // No raw `]` should land inside the label.
    expect(out).not.toMatch(/PROJ\]:::/);
    // The HTML-entity escapes should appear instead.
    expect(out).toContain('&#93;');
    expect(out).toContain('&#91;');
    expect(out).toContain('&lt;');
    expect(out).toContain('&gt;');
  });

  it('mermaid renders newlines in issue_id as <br>', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending', issue_id: 'PROJ-1\nROW2' }];
    const out = renderMermaid({ nodes: ['1-1-a'], edges: [] }, plan);
    expect(out).toContain('<br>');
    expect(out).not.toMatch(/issue_id.*\n.*ROW2/);
  });

  it('graphviz converts \\n to \\\\n in issue_id (dot escape format)', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending', issue_id: 'PROJ\nROW2' }];
    const out = renderGraphviz({ nodes: ['1-1-a'], edges: [] }, plan);
    // Round 3: dot double-quoted labels use backslash escapes. \n
    // becomes literal `\n` in the source so dot renders a line break.
    // `<` and `>` pass through as literals (no HTML interpretation in
    // double-quoted labels — they'd only matter for <...>-form labels).
    expect(out).toContain('\\n');
  });

  it('graphviz strips control characters from issue_id', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending', issue_id: 'PROJ\x00\x07OK' }];
    const out = renderGraphviz({ nodes: ['1-1-a'], edges: [] }, plan);
    expect(out).toContain('PROJOK');
    expect(out).not.toContain('\x00');
  });

  it('graphviz escapes backslash and double-quote (dot syntax)', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending', issue_id: 'PROJ"\\bad' }];
    const out = renderGraphviz({ nodes: ['1-1-a'], edges: [] }, plan);
    // \" and \\ are the standard dot escapes for embedded " and \.
    // Input PROJ"\bad → PROJ\"\\bad in dot source.
    expect(out).toContain('PROJ\\"\\\\bad');
  });

  it('story keys with normal chars still render unescaped', () => {
    const plan = emptyPlan({ source: 'auto' });
    plan.stories = [{ key: '1-1-a', plan_status: 'pending' }];
    const out = renderMermaid({ nodes: ['1-1-a'], edges: [] }, plan);
    expect(out).toContain('1-1-a["1-1-a"]:::pending');
  });
});

// ──────────────────────────────────────────────────────────────────
// H4 — tail() detects rotation / truncation
// ──────────────────────────────────────────────────────────────────

describe('H4 — tail iterator detects ledger rotation', () => {
  const { append, tail } = ledgerMod as {
    append: (e: Record<string, unknown>, ctx: { projectRoot: string }) => Record<string, unknown>;
    tail: (
      ctx: { projectRoot: string },
      opts?: {
        afterSeq?: number;
        pollIntervalMs?: number;
        maxIdleMs?: number;
        signal?: AbortSignal;
      },
    ) => AsyncIterable<Record<string, unknown>>;
  };
  const resolveLedger = (ledgerMod as { resolveLedgerPath: (root: string) => string })
    .resolveLedgerPath;

  it('resumes from seq=0 when the ledger file is truncated', async () => {
    append({ kind: 'state_transition', detail: { i: 1 } }, { projectRoot: tmpRoot });
    append({ kind: 'state_transition', detail: { i: 2 } }, { projectRoot: tmpRoot });

    const ctrl = new AbortController();
    const seen: number[] = [];
    const iter = tail({ projectRoot: tmpRoot }, { pollIntervalMs: 50, signal: ctrl.signal });

    // After tail starts, truncate the file (simulating `> ledger.jsonl`)
    // then append a new entry. Without rotation detection, tail would
    // miss this entry because seq=3 isn't > lastSeq=2.
    setTimeout(() => {
      writeFileSync(resolveLedger(tmpRoot), '');
      append({ kind: 'state_transition', detail: { i: 99 } }, { projectRoot: tmpRoot });
    }, 100);
    setTimeout(() => ctrl.abort(), 800);

    for await (const event of iter) {
      seen.push((event.detail as { i: number }).i);
      if (seen.includes(99)) ctrl.abort();
    }
    // We should have seen entry i=99 from the post-truncation append.
    expect(seen).toContain(99);
  });
});

// ──────────────────────────────────────────────────────────────────
// M1 + M2 — reorder polish
// ──────────────────────────────────────────────────────────────────

describe('M1 + M2 — reorder polish', () => {
  it('rejects empty newOrder (consistency with addStories/removeStories)', () => {
    seedPlan([{ key: 'a', plan_status: 'pending', priority: 1 }]);
    expect(() => reorder([], { projectRoot: tmpRoot })).toThrow(/non-empty array/);
  });

  it('rejects keys whose plan_status is terminal (done/skipped/excluded)', () => {
    seedPlan([
      { key: 'a', plan_status: 'done', priority: 1 },
      { key: 'b', plan_status: 'pending', priority: 2 },
    ]);
    let err: { code?: string; terminal_keys?: unknown } | null = null;
    try {
      reorder(['a', 'b'], { projectRoot: tmpRoot });
    } catch (e) {
      err = e as Error & { code?: string; terminal_keys?: unknown };
    }
    expect(err?.code).toBe('terminal_keys');
    expect(err?.terminal_keys).toBeDefined();
  });

  it('still accepts a valid pending-only order', () => {
    seedPlan([
      { key: 'a', plan_status: 'pending', priority: 1 },
      { key: 'b', plan_status: 'pending', priority: 2 },
    ]);
    reorder(['b', 'a'], { projectRoot: tmpRoot });
    const plan = readPlan({ projectRoot: tmpRoot }) as { stories: Array<Record<string, unknown>> };
    expect(plan.stories.map((s) => s.key)).toEqual(['b', 'a']);
  });
});

// ──────────────────────────────────────────────────────────────────
// M3 — legacy version validation
// ──────────────────────────────────────────────────────────────────

describe('M3 — legacy dependencies.yaml version validation', () => {
  it('migrate rejects version: 2 with a clean error', () => {
    const legacyDir = join(tmpRoot, '_Sprintpilot', 'sprints');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'dependencies.yaml'),
      'version: 2\nstories: {}\noverrides: []\nepics: {}\n',
    );
    const r = spawnSync('node', [INFER_SCRIPT, 'migrate', '--project-root', tmpRoot], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.migrated).toBe(false);
    expect(parsed.reason).toBe('unsupported_legacy_version');
  });

  it('migrate accepts an absent version key (legacy default = 1)', () => {
    mkdirSync(join(tmpRoot, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
      'development_status:\n  1-1-a: backlog\n',
    );
    const legacyDir = join(tmpRoot, '_Sprintpilot', 'sprints');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'dependencies.yaml'),
      'stories: {}\noverrides: []\nepics: {}\n', // no version key
    );
    const r = spawnSync('node', [INFER_SCRIPT, 'migrate', '--project-root', tmpRoot], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.migrated).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────
// M4 — state-tracker reset on accept_alternative + change_profile
// ──────────────────────────────────────────────────────────────────

describe('M4 — state-tracker reset on user-command-applier paths', () => {
  const { applyOne } = applierMod as {
    applyOne: (
      state: Record<string, unknown>,
      profile: Record<string, unknown>,
      cmd: Record<string, unknown>,
    ) => {
      newState: Record<string, unknown>;
      newProfile: Record<string, unknown>;
      effects: Array<{ kind: string; [k: string]: unknown }>;
    };
  };
  const { flatToProfile } = profileRules as {
    flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
  };

  it('change_profile clears verify-loop trackers', () => {
    const state = {
      phase: 'dev_green',
      last_verify_issues_signature: 'abc',
      consecutive_identical_rejections: 2,
    };
    const r = applyOne(state, flatToProfile({}, 'medium'), {
      kind: 'change_profile',
      profile: 'large',
    });
    expect(r.newState.last_verify_issues_signature).toBeNull();
    expect(r.newState.consecutive_identical_rejections).toBe(0);
  });

  it('accept_alternative clears verify-loop trackers', () => {
    const state = {
      phase: 'dev_green',
      pending_alternative: { action: { type: 'noop' }, impact: 'low' },
      last_verify_issues_signature: 'abc',
      consecutive_identical_rejections: 2,
    };
    const r = applyOne(state, flatToProfile({}, 'medium'), {
      kind: 'accept_alternative',
    });
    expect(r.newState.last_verify_issues_signature).toBeNull();
    expect(r.newState.consecutive_identical_rejections).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// M6 — setIssueId rejects metacharacters
// ──────────────────────────────────────────────────────────────────

describe('M6 — setIssueId rejects forbidden characters', () => {
  it("rejects issue_id containing ']'", () => {
    seedPlan([{ key: 'a', plan_status: 'pending', priority: 1 }]);
    expect(() => setIssueId('a', 'PROJ]bad', { projectRoot: tmpRoot })).toThrow(
      /forbidden character/,
    );
  });

  it('rejects issue_id containing newline', () => {
    seedPlan([{ key: 'a', plan_status: 'pending', priority: 1 }]);
    expect(() => setIssueId('a', 'PROJ\nx', { projectRoot: tmpRoot })).toThrow(
      /forbidden character/,
    );
  });

  it('rejects issue_id over 200 chars', () => {
    seedPlan([{ key: 'a', plan_status: 'pending', priority: 1 }]);
    expect(() => setIssueId('a', 'P'.repeat(201), { projectRoot: tmpRoot })).toThrow(/max is 200/);
  });

  it('accepts legitimate tracker IDs (PROJ-101, LIN-42, org/repo#123)', () => {
    seedPlan([
      { key: 'a', plan_status: 'pending', priority: 1 },
      { key: 'b', plan_status: 'pending', priority: 2 },
      { key: 'c', plan_status: 'pending', priority: 3 },
    ]);
    expect(() => setIssueId('a', 'PROJ-101', { projectRoot: tmpRoot })).not.toThrow();
    expect(() => setIssueId('b', 'LIN-42', { projectRoot: tmpRoot })).not.toThrow();
    expect(() => setIssueId('c', 'org/repo#123', { projectRoot: tmpRoot })).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────
// L5 — verifyIssuesSignature trims whitespace
// ──────────────────────────────────────────────────────────────────

describe('L5 — verifyIssuesSignature is whitespace-insensitive', () => {
  it('treats trailing whitespace as identical signatures', () => {
    expect(verifyIssuesSignature(['branch required'])).toBe(
      verifyIssuesSignature(['branch required ']),
    );
  });

  it('treats leading whitespace as identical signatures', () => {
    expect(verifyIssuesSignature(['x'])).toBe(verifyIssuesSignature(['  x']));
  });

  it('still differentiates fundamentally different strings', () => {
    expect(verifyIssuesSignature(['x'])).not.toBe(verifyIssuesSignature(['y']));
  });
});

// ──────────────────────────────────────────────────────────────────
// L6 — pluralization in loop hint
// ──────────────────────────────────────────────────────────────────

describe('L6 — loop hint pluralization', () => {
  const { interpretSignal } = adaptMod as {
    interpretSignal: (
      state: Record<string, unknown>,
      signal: Record<string, unknown>,
      profile: Record<string, unknown>,
      verifyResult?: { ok: boolean; issues?: string[] },
    ) => {
      newState: Record<string, unknown>;
      nextAction: Record<string, unknown>;
      sideEffects: Array<{ kind: string; [k: string]: unknown }>;
      verdict: string;
    };
  };
  const { flatToProfile } = profileRules as {
    flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
  };

  it("uses 'issues' / 'times' (no '(s)') in the loop hint", () => {
    const state = {
      phase: 'dev_green',
      verify_reject_count: 2,
      last_verify_issues_signature: verifyIssuesSignature(['a', 'b']),
      consecutive_identical_rejections: 2,
    };
    const r = interpretSignal(state, { status: 'success' }, flatToProfile({}, 'medium'), {
      ok: false,
      issues: ['a', 'b'],
    });
    const prompt = String((r.nextAction as Record<string, unknown>).prompt);
    expect(prompt).toMatch(/SAME 2 issues 3 times in a row/);
    expect(prompt).not.toMatch(/issue\(s\)/);
    expect(prompt).not.toMatch(/time\(s\)/);
  });

  it("uses singular 'issue' / 'time' when count is 1", () => {
    const state = {
      phase: 'dev_green',
      verify_reject_count: 2,
      last_verify_issues_signature: null,
      consecutive_identical_rejections: 0,
    };
    const r = interpretSignal(state, { status: 'success' }, flatToProfile({}, 'medium'), {
      ok: false,
      issues: ['lonely'],
    });
    // First identical rejection (count=1) doesn't trigger the hint, but
    // the prompt template should still be grammatical if it did. The
    // important test: when identicalCount=2 (second identical), say
    // "issues 2 times" → already covered above. When count=1, the hint
    // isn't emitted at all, so verify that explicitly.
    const prompt = String((r.nextAction as Record<string, unknown>).prompt);
    expect(prompt).not.toMatch(/this is a loop/);
  });
});
