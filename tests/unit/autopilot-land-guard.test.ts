import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import autopilot from '../../_Sprintpilot/bin/autopilot.js';
// @ts-expect-error — CommonJS module
import sprintPlan from '../../_Sprintpilot/scripts/sprint-plan.js';

type LedgerEntry = Record<string, unknown>;

type Classified = {
  prevStoryKey: string;
  prevBranch: string | null;
  doneConfirmed: boolean;
  landConfirmed: boolean;
} | null;

type Resolved = {
  prevStoryKey: string;
  branch: string | null;
  base: string;
  missingPhase: string;
} | null;

type GuardAction = {
  type: string;
  phase: string;
  reason?: string;
  missing_phase?: string;
  prior_story_key?: string;
  prior_branch?: string | null;
  next_story_key?: string | null;
} | null;

type Recovery = {
  recovered: boolean;
  story: string;
  branch: string | null;
  phase: string;
  reason: string;
} | null;

type Profile = {
  merge_strategy?: string;
  reuse_user_branch?: boolean;
  enabled?: boolean;
  base_branch?: string;
  branch_prefix?: string;
  granularity?: string;
  max_branch_length?: number;
};

type GitProbe = { baseContainsBranch: (branch: string, base: string) => boolean };

const {
  classifyUnlandedPredecessor,
  resolvePredecessorRecovery,
  guardLandAsYouGoPredecessor,
  recoverUnlandedPredecessor,
} = autopilot as {
  classifyUnlandedPredecessor: (entries: LedgerEntry[], nextStoryKey: string | null) => Classified;
  resolvePredecessorRecovery: (input: {
    entries: LedgerEntry[];
    nextStoryKey: string | null;
    profile: Profile;
    projectRoot?: string;
    gitProbe?: GitProbe;
  }) => Resolved;
  guardLandAsYouGoPredecessor: (input: {
    action: { type: string; phase: string } | null;
    runtime: { story_key: string | null } | null;
    profile: Profile;
    projectRoot?: string;
    ledgerEntries?: LedgerEntry[];
    gitProbe?: GitProbe;
  }) => GuardAction;
  recoverUnlandedPredecessor: (input: {
    persisted: Record<string, unknown>;
    profile: Profile;
    projectRoot?: string;
    ledgerEntries?: LedgerEntry[];
    gitProbe?: GitProbe;
  }) => Recovery;
};

const LAND_PROFILE: Profile = {
  merge_strategy: 'land_as_you_go',
  reuse_user_branch: false,
  enabled: true,
  base_branch: 'main',
  branch_prefix: 'story/',
  granularity: 'story',
  max_branch_length: 60,
};

const START_ACTION = { type: 'invoke_skill', phase: 'create_story' };
const NEXT_RUNTIME = { story_key: '16-8' };
const PROBE_NOT_LANDED: GitProbe = { baseContainsBranch: () => false };
const PROBE_LANDED: GitProbe = { baseContainsBranch: () => true };

function emitDone(storyKey: string, branch = `story/${storyKey}`): LedgerEntry {
  return {
    kind: 'action_emitted',
    phase: 'story_done',
    action: { type: 'git_op', op: 'commit_and_push_story', story_key: storyKey, branch },
  };
}
const TRANSITION_OUT_OF_DONE: LedgerEntry = {
  kind: 'state_transition',
  from: 'story_done',
  to: 'story_land',
  verdict: 'advanced',
};
const TRANSITION_OUT_OF_LAND: LedgerEntry = {
  kind: 'state_transition',
  from: 'story_land',
  to: 'epic_boundary_check',
  verdict: 'advanced',
};

// commit/push emitted, nothing confirmed.
const LEDGER_UNPUSHED: LedgerEntry[] = [emitDone('16-7')];
// committed + pushed (left story_done) but not yet landed.
const LEDGER_DONE_NOT_LANDED: LedgerEntry[] = [emitDone('16-7'), TRANSITION_OUT_OF_DONE];
// fully landed (left story_land).
const LEDGER_LANDED: LedgerEntry[] = [
  emitDone('16-7'),
  TRANSITION_OUT_OF_DONE,
  TRANSITION_OUT_OF_LAND,
];

describe('classifyUnlandedPredecessor', () => {
  it('returns null when no STORY_DONE git_op exists', () => {
    expect(classifyUnlandedPredecessor([], '16-8')).toBeNull();
    expect(
      classifyUnlandedPredecessor(
        [{ kind: 'action_emitted', phase: 'dev_green', action: { type: 'invoke_skill' } }],
        '16-8',
      ),
    ).toBeNull();
  });

  it('flags an unpushed predecessor (doneConfirmed=false, landConfirmed=false)', () => {
    expect(classifyUnlandedPredecessor(LEDGER_UNPUSHED, '16-8')).toEqual({
      prevStoryKey: '16-7',
      prevBranch: 'story/16-7',
      doneConfirmed: false,
      landConfirmed: false,
    });
  });

  it('flags a pushed-but-unlanded predecessor (doneConfirmed=true)', () => {
    expect(classifyUnlandedPredecessor(LEDGER_DONE_NOT_LANDED, '16-8')).toEqual({
      prevStoryKey: '16-7',
      prevBranch: 'story/16-7',
      doneConfirmed: true,
      landConfirmed: false,
    });
  });

  it('returns null when the predecessor fully landed', () => {
    expect(classifyUnlandedPredecessor(LEDGER_LANDED, '16-8')).toBeNull();
  });

  it('accepts a verify_result(story_land, ok) as land confirmation', () => {
    const entries = [emitDone('16-7'), { kind: 'verify_result', phase: 'story_land', ok: true }];
    expect(classifyUnlandedPredecessor(entries, '16-8')).toBeNull();
  });

  it('returns null when the predecessor is the same story being (re)started', () => {
    expect(classifyUnlandedPredecessor(LEDGER_UNPUSHED, '16-7')).toBeNull();
  });

  it('only considers the most recent STORY_DONE git_op', () => {
    const entries: LedgerEntry[] = [
      emitDone('16-6'),
      TRANSITION_OUT_OF_DONE,
      TRANSITION_OUT_OF_LAND,
      emitDone('16-7'),
    ];
    expect(classifyUnlandedPredecessor(entries, '16-8')).toMatchObject({
      prevStoryKey: '16-7',
      landConfirmed: false,
    });
  });
});

describe('resolvePredecessorRecovery', () => {
  it('returns missingPhase=story_done for an unpushed predecessor', () => {
    const r = resolvePredecessorRecovery({
      entries: LEDGER_UNPUSHED,
      nextStoryKey: '16-8',
      profile: LAND_PROFILE,
      projectRoot: '/tmp',
      gitProbe: PROBE_NOT_LANDED,
    });
    expect(r).toEqual({
      prevStoryKey: '16-7',
      branch: 'story/16-7',
      base: 'main',
      missingPhase: 'story_done',
    });
  });

  it('returns missingPhase=story_land for a pushed-but-unlanded predecessor', () => {
    const r = resolvePredecessorRecovery({
      entries: LEDGER_DONE_NOT_LANDED,
      nextStoryKey: '16-8',
      profile: LAND_PROFILE,
      projectRoot: '/tmp',
      gitProbe: PROBE_NOT_LANDED,
    });
    expect(r?.missingPhase).toBe('story_land');
  });

  it('returns null when origin/base already contains the branch (landed out-of-band)', () => {
    const r = resolvePredecessorRecovery({
      entries: LEDGER_DONE_NOT_LANDED,
      nextStoryKey: '16-8',
      profile: LAND_PROFILE,
      projectRoot: '/tmp',
      gitProbe: PROBE_LANDED,
    });
    expect(r).toBeNull();
  });

  it('derives the branch when the ledger omits it', () => {
    const r = resolvePredecessorRecovery({
      entries: [emitDone('16-7', undefined as unknown as string)].map((e) => ({
        ...e,
        action: { type: 'git_op', op: 'commit_and_push_story', story_key: '16-7' },
      })),
      nextStoryKey: '16-8',
      profile: LAND_PROFILE,
      projectRoot: '/tmp',
      gitProbe: PROBE_NOT_LANDED,
    });
    expect(r?.branch).toBe('story/16-7');
  });
});

describe('guardLandAsYouGoPredecessor', () => {
  it('halts (missing story_done) when the previous story was never committed/pushed', () => {
    const r = guardLandAsYouGoPredecessor({
      action: START_ACTION,
      runtime: NEXT_RUNTIME,
      profile: LAND_PROFILE,
      ledgerEntries: LEDGER_UNPUSHED,
      gitProbe: PROBE_NOT_LANDED,
    });
    expect(r?.type).toBe('user_prompt');
    expect(r?.reason).toBe('prior_story_not_landed');
    expect(r?.missing_phase).toBe('story_done');
    expect(r?.prior_story_key).toBe('16-7');
    expect(r?.next_story_key).toBe('16-8');
  });

  it('halts (missing story_land) when the previous story was pushed but never merged', () => {
    const r = guardLandAsYouGoPredecessor({
      action: START_ACTION,
      runtime: NEXT_RUNTIME,
      profile: LAND_PROFILE,
      ledgerEntries: LEDGER_DONE_NOT_LANDED,
      gitProbe: PROBE_NOT_LANDED,
    });
    expect(r?.missing_phase).toBe('story_land');
  });

  it('allows when the predecessor fully landed (ledger)', () => {
    expect(
      guardLandAsYouGoPredecessor({
        action: START_ACTION,
        runtime: NEXT_RUNTIME,
        profile: LAND_PROFILE,
        ledgerEntries: LEDGER_LANDED,
        gitProbe: PROBE_NOT_LANDED,
      }),
    ).toBeNull();
  });

  it('allows when origin/base contains the branch (landed out-of-band)', () => {
    expect(
      guardLandAsYouGoPredecessor({
        action: START_ACTION,
        runtime: NEXT_RUNTIME,
        profile: LAND_PROFILE,
        ledgerEntries: LEDGER_DONE_NOT_LANDED,
        gitProbe: PROBE_LANDED,
      }),
    ).toBeNull();
  });

  it('does not apply under the stacked merge strategy', () => {
    expect(
      guardLandAsYouGoPredecessor({
        action: START_ACTION,
        runtime: NEXT_RUNTIME,
        profile: { ...LAND_PROFILE, merge_strategy: 'stacked' },
        ledgerEntries: LEDGER_UNPUSHED,
        gitProbe: PROBE_NOT_LANDED,
      }),
    ).toBeNull();
  });

  it('does not apply when a single user branch is reused for every story', () => {
    expect(
      guardLandAsYouGoPredecessor({
        action: START_ACTION,
        runtime: NEXT_RUNTIME,
        profile: { ...LAND_PROFILE, reuse_user_branch: true },
        ledgerEntries: LEDGER_UNPUSHED,
        gitProbe: PROBE_NOT_LANDED,
      }),
    ).toBeNull();
  });

  it('only fires on fresh-story-start phases', () => {
    for (const phase of ['create_story', 'prepare_story_branch', 'nano_quick_dev']) {
      expect(
        guardLandAsYouGoPredecessor({
          action: { type: 'invoke_skill', phase },
          runtime: NEXT_RUNTIME,
          profile: LAND_PROFILE,
          ledgerEntries: LEDGER_UNPUSHED,
          gitProbe: PROBE_NOT_LANDED,
        }),
        `expected halt for ${phase}`,
      ).not.toBeNull();
    }
    for (const phase of ['dev_green', 'code_review', 'story_done', 'story_land']) {
      expect(
        guardLandAsYouGoPredecessor({
          action: { type: 'invoke_skill', phase },
          runtime: NEXT_RUNTIME,
          profile: LAND_PROFILE,
          ledgerEntries: LEDGER_UNPUSHED,
          gitProbe: PROBE_NOT_LANDED,
        }),
        `expected allow for ${phase}`,
      ).toBeNull();
    }
  });

  it('allows when re-emitting the same story (resume / retry)', () => {
    expect(
      guardLandAsYouGoPredecessor({
        action: START_ACTION,
        runtime: { story_key: '16-7' },
        profile: LAND_PROFILE,
        ledgerEntries: LEDGER_UNPUSHED,
        gitProbe: PROBE_NOT_LANDED,
      }),
    ).toBeNull();
  });

  it('allows when there is no predecessor (first story of the sprint)', () => {
    expect(
      guardLandAsYouGoPredecessor({
        action: START_ACTION,
        runtime: NEXT_RUNTIME,
        profile: LAND_PROFILE,
        ledgerEntries: [],
        gitProbe: PROBE_NOT_LANDED,
      }),
    ).toBeNull();
  });
});

describe('recoverUnlandedPredecessor', () => {
  function persisted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      current_story: '16-8',
      current_bmad_step: 'create_story',
      current_epic: '16',
      story_file_path: '/x/16-8.md',
      ...overrides,
    };
  }

  it('rewinds to story_done when the predecessor was never committed/pushed', () => {
    const p = persisted();
    const rec = recoverUnlandedPredecessor({
      persisted: p,
      profile: LAND_PROFILE,
      projectRoot: '/tmp',
      ledgerEntries: LEDGER_UNPUSHED,
      gitProbe: PROBE_NOT_LANDED,
    });
    expect(rec).toMatchObject({ recovered: true, story: '16-7', phase: 'story_done' });
    expect(p.current_story).toBe('16-7');
    expect(p.current_bmad_step).toBe('story_done');
    expect(p.current_epic).toBe('16');
    expect(p.story_file_path).toBeNull();
  });

  it('rewinds to story_land when the predecessor was pushed but not merged', () => {
    const p = persisted();
    const rec = recoverUnlandedPredecessor({
      persisted: p,
      profile: LAND_PROFILE,
      projectRoot: '/tmp',
      ledgerEntries: LEDGER_DONE_NOT_LANDED,
      gitProbe: PROBE_NOT_LANDED,
    });
    expect(rec).toMatchObject({ recovered: true, story: '16-7', phase: 'story_land' });
    expect(p.current_bmad_step).toBe('story_land');
  });

  it('does nothing when the predecessor fully landed', () => {
    const p = persisted();
    const rec = recoverUnlandedPredecessor({
      persisted: p,
      profile: LAND_PROFILE,
      projectRoot: '/tmp',
      ledgerEntries: LEDGER_LANDED,
      gitProbe: PROBE_NOT_LANDED,
    });
    expect(rec).toBeNull();
    expect(p.current_story).toBe('16-8');
  });

  it('does nothing when the persisted phase is mid-story (not a fresh-story start)', () => {
    const p = persisted({ current_bmad_step: 'dev_green' });
    const rec = recoverUnlandedPredecessor({
      persisted: p,
      profile: LAND_PROFILE,
      projectRoot: '/tmp',
      ledgerEntries: LEDGER_UNPUSHED,
      gitProbe: PROBE_NOT_LANDED,
    });
    expect(rec).toBeNull();
    expect(p.current_story).toBe('16-8');
  });

  it('does not apply under the stacked strategy', () => {
    const p = persisted();
    const rec = recoverUnlandedPredecessor({
      persisted: p,
      profile: { ...LAND_PROFILE, merge_strategy: 'stacked' },
      projectRoot: '/tmp',
      ledgerEntries: LEDGER_UNPUSHED,
      gitProbe: PROBE_NOT_LANDED,
    });
    expect(rec).toBeNull();
  });
});

// Integration: recovery → composeRuntimeState. Proves the rewind survives
// composeRuntimeState's rejection logic even when the plan prematurely
// marked the predecessor done (the root cause of the original FSM drift).
const { recoverUnlandedPredecessor: recover2, composeRuntimeState } = autopilot as {
  recoverUnlandedPredecessor: typeof recoverUnlandedPredecessor;
  composeRuntimeState: (
    persisted: Record<string, unknown>,
    profile: Profile,
    projectRoot: string,
  ) => { phase: string; story_key: string | null };
};
const { emptyPlan, write, addStories, markDone } = sprintPlan as {
  emptyPlan: (opts: { source: string }) => unknown;
  write: (plan: unknown, opts: { projectRoot: string }) => void;
  addStories: (entries: Array<{ key: string }>, opts: { projectRoot: string }) => void;
  markDone: (key: string, opts: { projectRoot: string }) => void;
};

describe('recovery + composeRuntimeState integration', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sp-land-int-'));
    const ia = join(root, '_bmad-output', 'implementation-artifacts');
    mkdirSync(ia, { recursive: true });
    writeFileSync(
      join(ia, 'sprint-status.yaml'),
      'development_status:\n  16-7-telegram: in-progress\n  16-8-next: backlog\n',
      'utf8',
    );
    // Simulate the premature plan markDone that fires when the FSM ENTERS
    // story_done — this is what makes composeRuntimeState reject the still
    // in-flight story unless the done-rejection is skipped at story_done.
    write(emptyPlan({ source: 'auto' }), { projectRoot: root });
    addStories([{ key: '16-7-telegram' }, { key: '16-8-next' }], { projectRoot: root });
    markDone('16-7-telegram', { projectRoot: root });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rewinds the drifted FSM to the unlanded predecessor and keeps it at story_done', () => {
    // Drifted state: the FSM jumped ahead to 16-8/create_story while 16-7's
    // commit/push never ran (the original land_as_you_go bug).
    const persistedState: Record<string, unknown> = {
      current_story: '16-8-next',
      current_bmad_step: 'create_story',
      current_epic: '16',
      story_file_path: null,
    };
    const ledgerEntries = [emitDone('16-7-telegram')];
    const rec = recover2({
      persisted: persistedState,
      profile: LAND_PROFILE,
      projectRoot: root,
      ledgerEntries,
      gitProbe: PROBE_NOT_LANDED,
    });
    expect(rec).toMatchObject({ recovered: true, story: '16-7-telegram', phase: 'story_done' });

    // Despite sprint-plan.yaml marking 16-7 done, composeRuntimeState must
    // NOT re-reset to the next story — it keeps the rewound predecessor so
    // the next emission re-runs its commit/push.
    const runtime = composeRuntimeState(persistedState, LAND_PROFILE, root);
    expect(runtime.phase).toBe('story_done');
    expect(runtime.story_key).toBe('16-7-telegram');
  });
});
