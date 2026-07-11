import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import autopilot from '../../../_Sprintpilot/bin/autopilot.js';
// @ts-expect-error — CommonJS module
import ledger from '../../../_Sprintpilot/lib/orchestrator/action-ledger.js';
// @ts-expect-error — CommonJS module
import fastLaneOverrides from '../../../_Sprintpilot/lib/orchestrator/fast-lane-overrides.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';

const setOverride = (
  fastLaneOverrides as {
    setOverride: (r: string, k: string, d: string, o?: { isEpic?: boolean }) => unknown;
  }
).setOverride;

const { deriveEffectiveProfile, buildRichStatus } = autopilot as {
  deriveEffectiveProfile: (
    persisted: Record<string, unknown>,
    profile: Record<string, unknown>,
    projectRoot: string,
    opts?: { emitLedger?: boolean },
  ) => Record<string, unknown>;
  buildRichStatus: (
    projectRoot: string,
    persisted: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Record<string, unknown>;
};
const appendLedger = (
  ledger as {
    append: (entry: Record<string, unknown>, ctx: { projectRoot: string }) => void;
  }
).append;
const { flatToProfile } = profileRules as {
  flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
};
const readLedger = (ledger as { read: (ctx: { projectRoot: string }) => Record<string, unknown>[] })
  .read;

let root: string;

const ART = ['_bmad-output', 'implementation-artifacts'];

function artDir() {
  const dir = join(root, ...ART);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeStory(key: string, content: string) {
  writeFileSync(join(artDir(), `${key}.md`), content, 'utf8');
}

function writeSprintStatus(yaml: string) {
  writeFileSync(join(artDir(), 'sprint-status.yaml'), yaml, 'utf8');
}

function writeSprintPlan(plan: Record<string, unknown>) {
  writeFileSync(join(artDir(), 'sprint-plan.yaml'), JSON.stringify(plan), 'utf8');
}

// A minimal valid plan (validatePlan requires these top-level keys).
function planWith(epics: unknown[], stories: unknown[]) {
  return {
    schema_version: 1,
    status: { last_run_outcome: 'success' },
    epics,
    stories,
    dependencies: { version: 1, stories: {} },
    cross_epic_deps: [],
    overrides: [],
  };
}

// A medium profile with the fast lane enabled (glob strings mirror the shipped
// config, exercising coerceGlobList inside flatToProfile).
function fastLaneProfile() {
  return flatToProfile(
    {
      autopilot: {
        fast_lane: {
          enabled: true,
          max_ac: 3,
          allow_globs: 'docs/**,**/*.md',
          deny_globs: '**/auth/**,**/migrations/**',
        },
      },
    },
    'medium',
  );
}

const DOCS_STORY =
  '## Acceptance Criteria\n- update the guide\n\n## File List\n- `docs/guide.md`\n';
const AUTH_STORY =
  '## Acceptance Criteria\n- harden login\n\n## File List\n- `src/auth/login.ts`\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-fastlane-derive-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('deriveEffectiveProfile', () => {
  it('returns the base profile unchanged when the fast lane is disabled', () => {
    writeStory('1-1-docs', DOCS_STORY);
    const base = flatToProfile({}, 'medium'); // fast_lane_enabled = false
    const eff = deriveEffectiveProfile({ current_story: '1-1-docs' }, base, root);
    expect(eff).toBe(base);
  });

  it('routes a low-risk docs story to the quick flow (pinned current_story)', () => {
    writeStory('1-1-docs', DOCS_STORY);
    const eff = deriveEffectiveProfile({ current_story: '1-1-docs' }, fastLaneProfile(), root);
    expect(eff.implementation_flow).toBe('quick');
    expect(eff.fast_lane_active).toBe(true);
  });

  it('keeps a security story on the full cycle (deny glob)', () => {
    writeStory('2-1-auth', AUTH_STORY);
    const eff = deriveEffectiveProfile({ current_story: '2-1-auth' }, fastLaneProfile(), root);
    expect(eff.implementation_flow).toBe('full');
    expect(eff.fast_lane_active).toBeUndefined();
  });

  it('resolves the next story from sprint-status when none is pinned', () => {
    writeStory('1-1-docs', DOCS_STORY);
    writeSprintStatus('development_status:\n  epic-1: in-progress\n  1-1-docs: backlog\n');
    const eff = deriveEffectiveProfile({}, fastLaneProfile(), root);
    expect(eff.implementation_flow).toBe('quick');
  });

  it('never fast-lanes a story recorded in fast_lane_forced_full (sticky escalation)', () => {
    writeStory('1-1-docs', DOCS_STORY);
    const eff = deriveEffectiveProfile(
      { current_story: '1-1-docs', fast_lane_forced_full: ['1-1-docs'] },
      fastLaneProfile(),
      root,
    );
    expect(eff.implementation_flow).toBe('full');
  });

  it('honors an epic-level fast_lane tag from sprint-plan.yaml (cascades to the story)', () => {
    // A neutral story (no story-file tag, no allow-listed paths) would default
    // to FULL — but its epic is tagged fast_lane:true in the plan.
    writeStory('4-1-neutral', '## Acceptance Criteria\n- do a small thing\n');
    writeSprintPlan(
      planWith(
        [{ id: '4', fast_lane: true }],
        [{ key: '4-1-neutral', epic: '4', plan_status: 'pending' }],
      ),
    );
    const eff = deriveEffectiveProfile({ current_story: '4-1-neutral' }, fastLaneProfile(), root);
    expect(eff.implementation_flow).toBe('quick');
  });

  it('a story-file tag overrides the epic plan tag (risk:high beats epic fast_lane:true)', () => {
    writeStory('4-2-risky', 'risk: high\n## Acceptance Criteria\n- do a thing\n');
    writeSprintPlan(
      planWith(
        [{ id: '4', fast_lane: true }],
        [{ key: '4-2-risky', epic: '4', plan_status: 'pending' }],
      ),
    );
    const eff = deriveEffectiveProfile({ current_story: '4-2-risky' }, fastLaneProfile(), root);
    expect(eff.implementation_flow).toBe('full');
  });

  it('LOCKS the decision at NANO_QUICK_DEV — quick-dev File-List drift cannot flip it off', () => {
    // At NANO_QUICK_DEV, quick-dev has already appended a File List of the code
    // it wrote (out-of-allowlist paths). Re-reading it would classify `full`
    // and drop fast_lane_active — defeating the escalation guards. A full
    // profile only reaches NANO_QUICK_DEV via the fast lane, so the decision is
    // locked to quick regardless of the file contents.
    writeStory(
      '4-1-docs',
      '## Acceptance Criteria\n- x\n\n## File List\n- `src/core/engine.ts`\n- `src/db/migrations/001.sql`\n',
    );
    const eff = deriveEffectiveProfile(
      { current_story: '4-1-docs', current_bmad_step: 'nano_quick_dev' },
      fastLaneProfile(),
      root,
    );
    expect(eff.implementation_flow).toBe('quick');
    expect(eff.fast_lane_active).toBe(true);
  });

  it('forced_full still wins over the NANO_QUICK_DEV lock', () => {
    writeStory('4-1-docs', DOCS_STORY);
    const eff = deriveEffectiveProfile(
      {
        current_story: '4-1-docs',
        current_bmad_step: 'nano_quick_dev',
        fast_lane_forced_full: ['4-1-docs'],
      },
      fastLaneProfile(),
      root,
    );
    expect(eff.implementation_flow).toBe('full');
  });

  it('classifies THIS story, not a stale persisted.story_file_path from a prior story (F3)', () => {
    // A docs story on disk, but persisted.story_file_path still points at a
    // previous, quick-lane-ineligible story's .md. The gate must read the
    // current story's convention path, not the stale one.
    writeStory('5-1-docs', DOCS_STORY);
    writeStory('4-9-prev', AUTH_STORY); // stale target with a deny path
    const eff = deriveEffectiveProfile(
      {
        current_story: '5-1-docs',
        story_file_path: join(artDir(), '4-9-prev.md'),
      },
      fastLaneProfile(),
      root,
    );
    expect(eff.implementation_flow).toBe('quick'); // read 5-1-docs, not 4-9-prev
  });

  it('is conservatively full when the story file is missing', () => {
    // No story file on disk → gate sees empty text → full.
    const eff = deriveEffectiveProfile({ current_story: '9-9-ghost' }, fastLaneProfile(), root);
    expect(eff.implementation_flow).toBe('full');
  });

  it('never throws — falls back to the base profile on a bad projectRoot', () => {
    const base = fastLaneProfile();
    const eff = deriveEffectiveProfile({ current_story: '1-1-docs' }, base, '/nonexistent/xyz');
    // Missing story file / no sprint-status → conservative full, base returned.
    expect(eff.implementation_flow).toBe('full');
  });
});

describe('deriveEffectiveProfile — user overrides (highest authority)', () => {
  const AUTH_BIG = // 5 ACs + an auth path: the gate would force this FULL
    '## Acceptance Criteria\n- a\n- b\n- c\n- d\n- e\n\n## File List\n- `src/auth/login.ts`\n';

  it('a fast override wins over deny-globs AND the size budget', () => {
    writeStory('4-1-auth', AUTH_BIG);
    setOverride(root, '4-1-auth', 'fast');
    const eff = deriveEffectiveProfile({ current_story: '4-1-auth' }, fastLaneProfile(), root);
    expect(eff.implementation_flow).toBe('quick');
    expect(eff.fast_lane_active).toBe(true);
  });

  it('a fast override works even when the lane is globally OFF', () => {
    writeStory('4-1-x', '## Acceptance Criteria\n- x\n');
    setOverride(root, '4-1-x', 'fast');
    const base = flatToProfile({}, 'medium'); // fast_lane_enabled = false
    const eff = deriveEffectiveProfile({ current_story: '4-1-x' }, base, root);
    expect(eff.implementation_flow).toBe('quick');
  });

  it('a full override forces the full cycle even for a fast-classifiable story', () => {
    writeStory('4-1-docs', DOCS_STORY); // gate would say fast
    setOverride(root, '4-1-docs', 'full');
    const eff = deriveEffectiveProfile({ current_story: '4-1-docs' }, fastLaneProfile(), root);
    expect(eff.implementation_flow).toBe('full');
  });

  it('forced_full (post-failure escalation) still beats a fast override — no loop', () => {
    writeStory('4-1-docs', DOCS_STORY);
    setOverride(root, '4-1-docs', 'fast');
    const eff = deriveEffectiveProfile(
      { current_story: '4-1-docs', fast_lane_forced_full: ['4-1-docs'] },
      fastLaneProfile(),
      root,
    );
    expect(eff.implementation_flow).toBe('full');
  });

  it('a story override wins over an epic override', () => {
    writeStory('4-1-x', '## Acceptance Criteria\n- x\n');
    setOverride(root, 'epic-4', 'full', { isEpic: true });
    setOverride(root, '4-1-x', 'fast');
    const base = flatToProfile({}, 'medium');
    const eff = deriveEffectiveProfile({ current_story: '4-1-x' }, base, root);
    expect(eff.implementation_flow).toBe('quick'); // story fast beats epic full
  });

  it('a full override arriving at NANO_QUICK_DEV does NOT strip fast_lane_active (escalation net preserved)', () => {
    // A story already at quick-dev is committed; a mid-flight `full` mark must
    // not silently defeat the escalation guards (which need fast_lane_active) —
    // it takes effect at the next story-start instead.
    writeStory('4-1-docs', DOCS_STORY);
    setOverride(root, '4-1-docs', 'full');
    const eff = deriveEffectiveProfile(
      { current_story: '4-1-docs', current_bmad_step: 'nano_quick_dev' },
      fastLaneProfile(),
      root,
    );
    expect(eff.implementation_flow).toBe('quick');
    expect(eff.fast_lane_active).toBe(true);
  });

  it('a fast override at a mid-full-cycle phase does NOT flip the profile', () => {
    // The story already entered the full cycle; a mark only takes effect at a
    // story-start phase, never mid-cycle.
    writeStory('4-1-docs', DOCS_STORY);
    setOverride(root, '4-1-docs', 'fast');
    const eff = deriveEffectiveProfile(
      { current_story: '4-1-docs', current_bmad_step: 'check_readiness' },
      fastLaneProfile(),
      root,
    );
    expect(eff.implementation_flow).toBe('full');
    expect(eff.fast_lane_active).toBeUndefined();
  });
});

describe('deriveEffectiveProfile — ledger audit', () => {
  it('emits one fast_lane_decision per story-start and dedups identical repeats', () => {
    writeStory('1-1-docs', DOCS_STORY);
    const persisted = { current_story: '1-1-docs', current_bmad_step: null };
    deriveEffectiveProfile(persisted, fastLaneProfile(), root, { emitLedger: true });
    deriveEffectiveProfile(persisted, fastLaneProfile(), root, { emitLedger: true });
    const decisions = readLedger({ projectRoot: root }).filter(
      (e) => e.kind === 'fast_lane_decision',
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ story_key: '1-1-docs', decision: 'fast' });
  });

  it('logs a new entry when the decision flips (fast → forced full)', () => {
    writeStory('1-1-docs', DOCS_STORY);
    deriveEffectiveProfile(
      { current_story: '1-1-docs', current_bmad_step: null },
      fastLaneProfile(),
      root,
      { emitLedger: true },
    );
    deriveEffectiveProfile(
      { current_story: '1-1-docs', current_bmad_step: null, fast_lane_forced_full: ['1-1-docs'] },
      fastLaneProfile(),
      root,
      { emitLedger: true },
    );
    const decisions = readLedger({ projectRoot: root }).filter(
      (e) => e.kind === 'fast_lane_decision',
    );
    expect(decisions.map((d) => d.decision)).toEqual(['fast', 'full']);
  });

  it('RECORDS the fast decision at the NANO_QUICK_DEV lock (the real routing point)', () => {
    // At CREATE_STORY the story file doesn't exist yet so the gate logs `full`;
    // the actual `fast` routing is only knowable once the file exists, and the
    // NANO_QUICK_DEV lock is the first emitting phase where that holds. Without
    // logging here a fast-laned story would only ever record the misleading
    // `full`, and every fast-lane metric would read zero.
    writeStory(
      '3-1-docs',
      '## Acceptance Criteria\n- x\n\n## File List\n- `src/core/engine.ts`\n', // out-of-allowlist (drift)
    );
    deriveEffectiveProfile(
      { current_story: '3-1-docs', current_bmad_step: 'nano_quick_dev' },
      fastLaneProfile(),
      root,
      { emitLedger: true },
    );
    const decisions = readLedger({ projectRoot: root }).filter(
      (e) => e.kind === 'fast_lane_decision',
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ story_key: '3-1-docs', decision: 'fast' });
  });

  it('a full→fast sequence makes buildRichStatus count the story as fast-laned', () => {
    writeStory('3-2-docs', DOCS_STORY);
    // Emission 1: create-story phase, file not yet classifiable as this test
    // simulates via an explicit full entry, then the lock records fast.
    deriveEffectiveProfile(
      { current_story: '3-2-docs', current_bmad_step: 'create_story' },
      fastLaneProfile(),
      root,
      { emitLedger: true },
    );
    deriveEffectiveProfile(
      { current_story: '3-2-docs', current_bmad_step: 'nano_quick_dev' },
      fastLaneProfile(),
      root,
      { emitLedger: true },
    );
    const s = buildRichStatus(root, { current_story: '3-2-docs' }, {}) as {
      fast_lane: { fast_laned: number; current_decision: string };
    };
    expect(s.fast_lane.fast_laned).toBe(1);
    expect(s.fast_lane.current_decision).toBe('fast');
  });

  it('logs two different stories with the SAME decision (dedup is per-story, not global)', () => {
    // The dedup keys on (story_key, decision) — a new story must always log,
    // even if its decision matches the previous story's.
    writeStory('7-1-a', '## Acceptance Criteria\n- do a thing\n'); // no paths → full
    writeStory('7-2-b', '## Acceptance Criteria\n- do another\n'); // no paths → full
    deriveEffectiveProfile(
      { current_story: '7-1-a', current_bmad_step: 'create_story' },
      fastLaneProfile(),
      root,
      { emitLedger: true },
    );
    deriveEffectiveProfile(
      { current_story: '7-2-b', current_bmad_step: 'create_story' },
      fastLaneProfile(),
      root,
      { emitLedger: true },
    );
    const decisions = readLedger({ projectRoot: root }).filter(
      (e) => e.kind === 'fast_lane_decision',
    );
    expect(decisions.map((d) => [d.story_key, d.decision])).toEqual([
      ['7-1-a', 'full'],
      ['7-2-b', 'full'],
    ]);
  });

  it('does not emit a ledger entry mid-story (non-story-start phase)', () => {
    writeStory('1-1-docs', DOCS_STORY);
    deriveEffectiveProfile(
      { current_story: '1-1-docs', current_bmad_step: 'code_review' },
      fastLaneProfile(),
      root,
      { emitLedger: true },
    );
    const decisions = readLedger({ projectRoot: root }).filter(
      (e) => e.kind === 'fast_lane_decision',
    );
    expect(decisions).toHaveLength(0);
  });
});

describe('buildRichStatus — fast-lane field', () => {
  it('is null when the lane never fired', () => {
    const s = buildRichStatus(root, { current_story: '1-1' }, {});
    expect(s.fast_lane).toBeNull();
  });

  it('surfaces fast-laned / escalated counts and the current story decision', () => {
    appendLedger(
      { kind: 'fast_lane_decision', story_key: '1-1', decision: 'fast', reasons: [] },
      { projectRoot: root },
    );
    appendLedger(
      { kind: 'fast_lane_decision', story_key: '1-2', decision: 'full', reasons: [] },
      { projectRoot: root },
    );
    appendLedger(
      { kind: 'profile_escalated', from: 'fast_lane', story_key: '1-3', reason: 'tests_failed' },
      { projectRoot: root },
    );
    const s = buildRichStatus(root, { current_story: '1-1' }, {}) as {
      fast_lane: { current_decision: string; fast_laned: number; escalated: number };
    };
    expect(s.fast_lane.fast_laned).toBe(1);
    expect(s.fast_lane.escalated).toBe(1);
    expect(s.fast_lane.current_decision).toBe('fast');
  });

  it('shows fast→full for a story currently running its escalated full cycle (F6)', () => {
    appendLedger(
      { kind: 'fast_lane_decision', story_key: '2-1', decision: 'fast', reasons: [] },
      { projectRoot: root },
    );
    appendLedger(
      { kind: 'profile_escalated', from: 'fast_lane', story_key: '2-1', reason: 'high_severity' },
      { projectRoot: root },
    );
    const s = buildRichStatus(root, { current_story: '2-1' }, {}) as {
      fast_lane: { current_decision: string };
    };
    expect(s.fast_lane.current_decision).toBe('fast→full');
  });
});
