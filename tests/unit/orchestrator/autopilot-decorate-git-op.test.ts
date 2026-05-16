import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error — CommonJS module
import autopilot from '../../../_Sprintpilot/bin/autopilot.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';

const { decorateGitOp, decorateRunScript, composeRuntimeState } = autopilot as {
  decorateGitOp: (
    action: Record<string, unknown>,
    state: Record<string, unknown>,
    profile: Record<string, unknown>,
    projectRoot?: string,
  ) => Record<string, unknown>;
  decorateRunScript: (
    action: Record<string, unknown>,
    state: Record<string, unknown>,
    profile: Record<string, unknown>,
    projectRoot?: string,
  ) => Record<string, unknown>;
  composeRuntimeState: (
    persisted: Record<string, unknown>,
    profile: Record<string, unknown>,
    projectRoot?: string,
  ) => Record<string, unknown>;
};

const { flatToProfile } = profileRules as {
  flatToProfile: (resolved: unknown, name: string) => Record<string, unknown>;
};

function state(extra: Record<string, unknown> = {}) {
  return {
    phase: 'story_done',
    story_key: 'S1.2',
    current_epic: 'E1',
    ac_summary: 'A',
    ...extra,
  };
}

describe('decorateGitOp — git.enabled short-circuit', () => {
  it('replaces planned steps with an empty list when enabled=false', () => {
    const profile = { ...flatToProfile({}, 'medium'), enabled: false };
    const action = decorateGitOp(
      { type: 'git_op', op: 'commit_and_push_story', phase: 'story_done' },
      state(),
      profile,
    );
    expect(action.type).toBe('git_op');
    expect(action.git_disabled).toBe(true);
    expect((action as { steps?: unknown[] }).steps).toEqual([]);
    expect((action as { branch?: unknown }).branch).toBeNull();
  });

  it('passes through unchanged when enabled=true (default)', () => {
    const profile = flatToProfile({}, 'medium');
    const action = decorateGitOp(
      { type: 'git_op', op: 'commit_and_push_story', phase: 'story_done' },
      state(),
      profile,
    );
    expect(action.git_disabled).toBeUndefined();
    expect(Array.isArray((action as { steps?: unknown[] }).steps)).toBe(true);
    expect(((action as { steps?: unknown[] }).steps as unknown[]).length).toBeGreaterThan(0);
  });

  it('leaves non-git_op actions untouched even when enabled=false', () => {
    const profile = { ...flatToProfile({}, 'medium'), enabled: false };
    const skill = { type: 'invoke_skill', skill: 'bmad-create-story' };
    const action = decorateGitOp(skill, state(), profile);
    expect(action).toBe(skill);
  });
});

// Build a temp project root with a sprint-status.yaml. Accepts either
// a single pending story key (convenience) or a full development_status
// block as a string. Returns { projectRoot, cleanup }.
function makeProjectWithSprintStatus(pendingStory: string | null, raw?: string) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'sp-compose-test-'));
  const dir = join(projectRoot, '_bmad-output', 'implementation-artifacts');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('node:fs').mkdirSync(dir, { recursive: true });
  if (raw !== undefined) {
    writeFileSync(join(dir, 'sprint-status.yaml'), raw, 'utf8');
  } else if (pendingStory !== null) {
    writeFileSync(
      join(dir, 'sprint-status.yaml'),
      `development_status:\n  ${pendingStory}: ready-for-dev\n`,
      'utf8',
    );
  }
  return { projectRoot, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

describe('composeRuntimeState — migration of legacy current_bmad_step', () => {
  const medium = () => flatToProfile({}, 'medium');

  it('bumps create_story → prepare_story_branch on fresh sprint upgrade + resolves story_key from sprint-status', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus('1-1-foo');
    try {
      const r = composeRuntimeState({ current_bmad_step: 'create_story' }, medium(), projectRoot);
      expect(r.phase).toBe('prepare_story_branch');
      expect(r.story_key).toBe('1-1-foo');
      expect(r.current_epic).toBe('1');
    } finally {
      cleanup();
    }
  });

  it('falls back to flowStart when migration would route to PREPARE_STORY_BRANCH but sprint-status has nothing pending', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(null);
    try {
      const r = composeRuntimeState({ current_bmad_step: 'create_story' }, medium(), projectRoot);
      // Migration would have bumped to prepare_story_branch, but no
      // story_key resolves → fall back to flowStart (create_story).
      expect(r.phase).toBe('create_story');
      expect(r.story_key).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('skips epic rollup headers when resolving next story (regression: v2.1.4 picked epic-4 as story_key)', () => {
    // Real BMad sprint-status.yaml shape: epic rollups live next to
    // stories under development_status. parseStatuses returns them
    // flat; the resolver must filter out non-story entries.
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  epic-4: in-progress',
        '  4-2b-speaker-enrollment: done',
        '  4-5-realm-config: backlog',
        '  4-8-realm-wide-matcher-and-session-lock: ready-for-dev',
        '  4-retrospective: pending',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'create_story' },
        flatToProfile({}, 'medium'),
        projectRoot,
      );
      // epic-4 is rejected (epic header).
      // 4-2b is rejected (done).
      // 4-retrospective is rejected (retro entry).
      // 4-5 is the first remaining real story.
      expect(r.phase).toBe('prepare_story_branch');
      expect(r.story_key).toBe('4-5-realm-config');
      expect(r.current_epic).toBe('4');
    } finally {
      cleanup();
    }
  });

  it('skips *-retrospective entries (regression: looksLikeStoryKey)', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-retrospective: pending',
        '  4-8-realm-wide-matcher-and-session-lock: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'create_story' },
        flatToProfile({}, 'medium'),
        projectRoot,
      );
      expect(r.story_key).toBe('4-8-realm-wide-matcher-and-session-lock');
    } finally {
      cleanup();
    }
  });

  it('falls back to flowStart when only epic headers and retrospectives are pending (no real stories)', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  epic-4: in-progress',
        '  4-retrospective: pending',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'create_story' },
        flatToProfile({}, 'medium'),
        projectRoot,
      );
      expect(r.phase).toBe('create_story');
      expect(r.story_key).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('accepts epic-prefixed story keys (epic-1-game-engine, not epic header)', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  epic-1: in-progress',
        '  epic-1-game-engine: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'create_story' },
        flatToProfile({}, 'medium'),
        projectRoot,
      );
      expect(r.story_key).toBe('epic-1-game-engine');
      expect(r.current_epic).toBe('epic-1');
    } finally {
      cleanup();
    }
  });

  it('persisted PREPARE_STORY_BRANCH + null story_key resolves from sprint-status', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus('2-3-bar');
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'prepare_story_branch' },
        medium(),
        projectRoot,
      );
      expect(r.phase).toBe('prepare_story_branch');
      expect(r.story_key).toBe('2-3-bar');
      expect(r.current_epic).toBe('2');
    } finally {
      cleanup();
    }
  });

  it('persisted PREPARE_STORY_BRANCH + null story_key + no sprint-status falls back to flowStart', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(null);
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'prepare_story_branch' },
        medium(),
        projectRoot,
      );
      expect(r.phase).toBe('create_story');
    } finally {
      cleanup();
    }
  });

  it('leaves create_story alone when current_story is set (mid-story)', () => {
    const r = composeRuntimeState(
      { current_bmad_step: 'create_story', current_story: 'S1.2' },
      medium(),
    );
    expect(r.phase).toBe('create_story');
  });

  it('migrates when story_file_path is set but the file does not exist (stale persist) + resolves story_key', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus('3-1-baz');
    try {
      // A persisted story_file_path can be optimistically written before
      // the skill actually creates the file (e.g. coalesce_state_writes).
      // The migration logic must check existence to avoid the false-
      // positive mid-story signal.
      const r = composeRuntimeState(
        { current_bmad_step: 'create_story', story_file_path: '/nope/does-not-exist.md' },
        medium(),
        projectRoot,
      );
      expect(r.phase).toBe('prepare_story_branch');
      expect(r.story_key).toBe('3-1-baz');
    } finally {
      cleanup();
    }
  });

  it('leaves create_story alone when story_file_path points at a real file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-migration-test-'));
    const path = join(dir, 'story.md');
    writeFileSync(path, '# Story\n');
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'create_story', story_file_path: path },
        medium(),
      );
      expect(r.phase).toBe('create_story');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves create_story alone when prior_diagnosis is set (mid-retry)', () => {
    const r = composeRuntimeState(
      { current_bmad_step: 'create_story', prior_diagnosis: 'AC section missing' },
      medium(),
    );
    expect(r.phase).toBe('create_story');
  });

  it('preserves mid-cycle phases when story_key is set (genuine in-flight story)', () => {
    // The migration that bumps create_story → prepare_story_branch only
    // applies to fresh-story-start. Past create_story, with story_key
    // set, the phase is preserved — we're mid-cycle on a specific story.
    for (const phase of ['check_readiness', 'dev_red', 'dev_green', 'code_review']) {
      const r = composeRuntimeState(
        { current_bmad_step: phase, current_story: 'S1.2' },
        medium(),
      );
      expect(r.phase).toBe(phase);
    }
  });

  it('resets story-bound phases to flowStart when story_key is null (v2.2.10 catch-all)', () => {
    // Real-world: a prior orchestrator version nulled current_story but
    // didn't reset phase. Persisted state ends up with current_story:null
    // at e.g. dev_red. The catch-all in composeRuntimeState resets phase
    // to flowStart so the next emission re-enters story-start cleanly
    // instead of emitting an invoke_skill bmad-dev-story with no story.
    for (const phase of ['check_readiness', 'dev_red', 'dev_green', 'code_review', 'story_done']) {
      const r = composeRuntimeState({ current_bmad_step: phase }, medium());
      // flowStart for full flow is create_story; under needsBranchPrep
      // the migration block bumps to prepare_story_branch.
      expect(['create_story', 'prepare_story_branch']).toContain(r.phase);
    }
  });

  it('does NOT migrate under reuse_user_branch=true', () => {
    const p = { ...medium(), reuse_user_branch: true };
    const r = composeRuntimeState({ current_bmad_step: 'create_story' }, p);
    expect(r.phase).toBe('create_story');
  });

  it('does NOT migrate under enabled=false', () => {
    const p = { ...medium(), enabled: false };
    const r = composeRuntimeState({ current_bmad_step: 'create_story' }, p);
    expect(r.phase).toBe('create_story');
  });
});

describe('composeRuntimeState — bug #1: remaining_stories_in_epic populated from sprint-status', () => {
  const medium = () => flatToProfile({}, 'medium');

  it('counts non-done stories in the current epic (excludes done + epic headers + retrospectives)', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  epic-4: in-progress',
        '  4-1-foo: done',          // excluded: done
        '  4-2-bar: ready-for-dev', // counted
        '  4-3-baz: backlog',       // counted
        '  4-retrospective: pending', // excluded: retro entry
        '  5-1-other: backlog',     // excluded: different epic
        '',
      ].join('\n'),
    );
    try {
      // Mid-story in epic 4. composeRuntimeState should count remaining
      // non-done stories under epic 4: 4-2-bar, 4-3-baz = 2.
      const r = composeRuntimeState(
        { current_bmad_step: 'dev_red', current_story: '4-2-bar', current_epic: '4' },
        medium(),
        projectRoot,
      );
      expect(r.remaining_stories_in_epic).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('returns 0 when all epic stories are done (end-of-epic signal for state machine)', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-1-foo: done',
        '  4-2-bar: done',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'epic_boundary_check', current_epic: '4' },
        medium(),
        projectRoot,
      );
      expect(r.remaining_stories_in_epic).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('falls back to persisted value when current_epic is null (no resolution possible)', () => {
    const r = composeRuntimeState(
      { current_bmad_step: 'create_story', remaining_stories_in_epic: 7 },
      medium(),
    );
    expect(r.remaining_stories_in_epic).toBe(7);
  });
});

describe('composeRuntimeState — persisted current_story validation (poisoned state recovery)', () => {
  const medium = () => flatToProfile({}, 'medium');

  it('nullifies persisted current_story when it matches epic-rollup shape (v2.1.3/v2.1.4 poison)', () => {
    // Real-world bug: a user's autopilot-state.yaml had current_story: epic-4
    // (poisoned by pre-v2.1.5 resolveNextStoryKey before the filter shipped).
    // composeRuntimeState used to pass this through verbatim, producing
    // `branch: story/epic-4` on every emission. v2.2.4: validate and drop.
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  epic-4: in-progress',
        '  4-8-realm: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'prepare_story_branch', current_story: 'epic-4', current_epic: 'epic' },
        medium(),
        projectRoot,
      );
      // current_story rejected; orchestrator falls through to sprint-status
      // resolution and picks the next real story.
      expect(r.story_key).toBe('4-8-realm');
      expect(r.current_epic).toBe('4');
    } finally {
      cleanup();
    }
  });

  it('nullifies persisted current_story when it matches retrospective shape', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-retrospective: pending',
        '  4-8-realm: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'prepare_story_branch', current_story: '4-retrospective' },
        medium(),
        projectRoot,
      );
      expect(r.story_key).toBe('4-8-realm');
    } finally {
      cleanup();
    }
  });

  it('nullifies persisted current_story when it is not in sprint-status.yaml', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-8-realm: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'prepare_story_branch', current_story: '4-7-deleted-story' },
        medium(),
        projectRoot,
      );
      expect(r.story_key).toBe('4-8-realm');
    } finally {
      cleanup();
    }
  });

  it("does NOT nullify current_story when sprint-status shows 'done' AND phase is story-bound (STORY_DONE is the expected state)", () => {
    // Regression v2.2.9: pre-2.2.9 the "marked done" rejection fired
    // regardless of phase. At STORY_DONE the story IS expected to be
    // done in sprint-status (verifyStoryDone enforces it). Nullifying
    // mid-record produced branch "story/unknown" on commit_and_push_story.
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-9-foo: done  # PR #99 merged',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'story_done', current_story: '4-9-foo', current_epic: '4' },
        flatToProfile({}, 'medium'),
        projectRoot,
      );
      // story_key preserved → branch resolves correctly downstream.
      expect(r.story_key).toBe('4-9-foo');
      expect(r.phase).toBe('story_done');
    } finally {
      cleanup();
    }
  });

  it('rejects current_story marked done when phase IS story-start (poisoned state from prior session)', () => {
    // The "done" rejection still fires at story-start phases — that
    // means we're picking up state where the previous story finished
    // but state wasn't reset.
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-8-old: done',
        '  4-9-next: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'prepare_story_branch', current_story: '4-8-old' },
        flatToProfile({}, 'medium'),
        projectRoot,
      );
      // 4-8-old rejected → falls through to resolveNextStoryKey → 4-9-next.
      expect(r.story_key).toBe('4-9-next');
    } finally {
      cleanup();
    }
  });

  it('rejects + resets phase to flowStart when current_story is poisoned AND phase is story-bound (non-done rejection)', () => {
    // Epic-rollup poison at story-bound phase: orchestrator can't emit
    // a coherent action with story_key=null at dev_red. Reset to
    // flowStart so the next emission re-enters story-start cleanly.
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  epic-4: in-progress',
        '  4-9-real: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'dev_red', current_story: 'epic-4', current_epic: 'epic' },
        flatToProfile({}, 'medium'),
        projectRoot,
      );
      // epic-4 rejected (poisoned shape), phase reset to create_story (flowStart),
      // story_key re-resolved via resolveNextStoryKey at prepare_story_branch...
      // actually flowStart=create_story so resolveNextStoryKey doesn't fire here.
      // Either way: phase advanced past dev_red so the emission isn't broken.
      expect(r.phase).not.toBe('dev_red');
      expect(['create_story', 'prepare_story_branch']).toContain(r.phase);
    } finally {
      cleanup();
    }
  });

  it("nullifies persisted current_story when sprint-status shows it as 'done'", () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-7-foo: done  # already shipped',
        '  4-8-realm: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'prepare_story_branch', current_story: '4-7-foo' },
        medium(),
        projectRoot,
      );
      expect(r.story_key).toBe('4-8-realm');
    } finally {
      cleanup();
    }
  });

  it('preserves valid persisted current_story', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-8-realm: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'dev_red', current_story: '4-8-realm', current_epic: '4' },
        medium(),
        projectRoot,
      );
      expect(r.story_key).toBe('4-8-realm');
      expect(r.phase).toBe('dev_red');
    } finally {
      cleanup();
    }
  });

  it('preserves persisted current_story when sprint-status is missing (defensive — no artifact ≠ poison)', () => {
    // No sprint-status.yaml. The validator returns null (defer); the
    // orchestrator preserves persisted state so the user can keep working
    // even before/without sprint-planning.
    const r = composeRuntimeState(
      { current_bmad_step: 'dev_red', current_story: 'S1.2', current_epic: 'E1' },
      medium(),
    );
    expect(r.story_key).toBe('S1.2');
  });

  it('preserves short test-style keys like S1 / S1.2 (narrow filter, not the strict looksLikeStoryKey)', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  S1: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        { current_bmad_step: 'dev_red', current_story: 'S1' },
        medium(),
        projectRoot,
      );
      // S1 has no hyphen so strict looksLikeStoryKey would reject; the
      // narrow validator must accept it (it's in sprint-status, not done,
      // doesn't match epic-N / bare-N / -retrospective shapes).
      expect(r.story_key).toBe('S1');
    } finally {
      cleanup();
    }
  });
});

describe('composeRuntimeState — story_queue validation (poisoned entries dropped)', () => {
  const medium = () => flatToProfile({}, 'medium');

  it('filters out epic-header entries from persisted story_queue', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-8-realm: ready-for-dev',
        '  4-9-next: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        {
          current_bmad_step: 'create_story',
          story_queue: ['epic-4', '4-8-realm', 'epic-5', '4-9-next'],
        },
        medium(),
        projectRoot,
      );
      expect(r.story_queue).toEqual(['4-8-realm', '4-9-next']);
    } finally {
      cleanup();
    }
  });

  it('filters out retrospective entries from persisted story_queue', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-8-realm: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        {
          current_bmad_step: 'create_story',
          story_queue: ['4-retrospective', '4-8-realm', 'epic-4-retrospective'],
        },
        medium(),
        projectRoot,
      );
      expect(r.story_queue).toEqual(['4-8-realm']);
    } finally {
      cleanup();
    }
  });

  it('filters out entries marked done in sprint-status', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-7-old: done  # PR #99 merged',
        '  4-8-realm: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        {
          current_bmad_step: 'create_story',
          story_queue: ['4-7-old', '4-8-realm'],
        },
        medium(),
        projectRoot,
      );
      expect(r.story_queue).toEqual(['4-8-realm']);
    } finally {
      cleanup();
    }
  });

  it('filters out entries not present in sprint-status', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-8-realm: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        {
          current_bmad_step: 'create_story',
          story_queue: ['4-7-deleted-story', '4-8-realm', '99-never-existed'],
        },
        medium(),
        projectRoot,
      );
      expect(r.story_queue).toEqual(['4-8-realm']);
    } finally {
      cleanup();
    }
  });

  it('preserves valid queue entries as-is', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-8-realm: ready-for-dev',
        '  4-9-next: backlog',
        '  4-10-after: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        {
          current_bmad_step: 'create_story',
          story_queue: ['4-8-realm', '4-9-next', '4-10-after'],
        },
        medium(),
        projectRoot,
      );
      expect(r.story_queue).toEqual(['4-8-realm', '4-9-next', '4-10-after']);
    } finally {
      cleanup();
    }
  });

  it('all-invalid queue empties safely (orchestrator falls through to resolveNextStoryKey)', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  4-8-realm: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        {
          current_bmad_step: 'prepare_story_branch',
          story_queue: ['epic-4', 'epic-5', '4-retrospective'],
        },
        medium(),
        projectRoot,
      );
      expect(r.story_queue).toEqual([]);
      // Falls through to resolveNextStoryKey → picks 4-8-realm.
      expect(r.story_key).toBe('4-8-realm');
    } finally {
      cleanup();
    }
  });

  it('preserves queue shape-based filtering when sprint-status is missing (defensive)', () => {
    // Without sprint-status, presence/status checks defer. Only shape-
    // based rejections (epic-N, retrospective) fire.
    const r = composeRuntimeState(
      {
        current_bmad_step: 'create_story',
        story_queue: ['epic-4', '4-8-realm', '4-retrospective', 'S1.2'],
      },
      medium(),
    );
    // epic-4 + 4-retrospective dropped; 4-8-realm + S1.2 preserved
    // (can't verify they exist without sprint-status, so trust them).
    expect(r.story_queue).toEqual(['4-8-realm', 'S1.2']);
  });
});

describe('composeRuntimeState — bug #3: queue consumption gated to story-start phases', () => {
  const medium = () => flatToProfile({}, 'medium');

  it('does NOT consume queue at EPIC_BOUNDARY_CHECK (would pollute state)', () => {
    const r = composeRuntimeState(
      {
        current_bmad_step: 'epic_boundary_check',
        current_story: null,
        current_epic: '4',
        story_queue: ['5-1-next-epic-first', '5-2-next-epic-second'],
      },
      medium(),
    );
    expect(r.phase).toBe('epic_boundary_check');
    expect(r.story_key).toBeNull();
    expect(r.current_epic).toBe('4');
  });

  it('does NOT consume queue at RETROSPECTIVE (preserves current_epic for verify)', () => {
    const r = composeRuntimeState(
      {
        current_bmad_step: 'retrospective',
        current_story: null,
        current_epic: '4',
        story_queue: ['5-1-next'],
      },
      medium(),
    );
    expect(r.phase).toBe('retrospective');
    expect(r.story_key).toBeNull();
    expect(r.current_epic).toBe('4');
  });

  it('DOES consume queue at CREATE_STORY (story-start phase)', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  5-1-next: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        {
          current_bmad_step: 'create_story',
          current_story: null,
          current_epic: '4',
          story_queue: ['5-1-next'],
        },
        medium(),
        projectRoot,
      );
      expect(r.story_key).toBe('5-1-next');
      // Cross-epic queue: current_epic re-derived from new story_key.
      expect(r.current_epic).toBe('5');
    } finally {
      cleanup();
    }
  });

  it('cross-epic queue at PREPARE_STORY_BRANCH re-derives current_epic from new story_key', () => {
    const { projectRoot, cleanup } = makeProjectWithSprintStatus(
      null,
      [
        'development_status:',
        '  5-1-next: ready-for-dev',
        '',
      ].join('\n'),
    );
    try {
      const r = composeRuntimeState(
        {
          current_bmad_step: 'prepare_story_branch',
          current_story: null,
          current_epic: '4', // stale from previous story; should not carry
          story_queue: ['5-1-next'],
        },
        medium(),
        projectRoot,
      );
      expect(r.story_key).toBe('5-1-next');
      expect(r.current_epic).toBe('5');
    } finally {
      cleanup();
    }
  });
});

describe('decorateRunScript — inlines land.js#planLand steps for land_as_you_go (v2.2.12 fix)', () => {
  const landProfile = () => ({ ...flatToProfile({}, 'medium'), merge_strategy: 'land_as_you_go' });

  it('expands op:land_story run_script into an argv steps[] list', () => {
    // Pre-v2.2.12 the action emitted by STORY_LAND was metadata-only:
    //   { type: "run_script", op: "land_story", helper: "lib/orchestrator/land.js",
    //     land_when: "ci_pass", squash_on_merge: false, ... }
    // No `args` / `command` / `steps` — the LLM had to invent its own
    // gh invocation. v2.2.12: decorateRunScript calls land.planLand and
    // inlines the resulting argv steps.
    const action = {
      type: 'run_script',
      phase: 'story_land',
      op: 'land_story',
      story_key: '4-12-foo',
      profile: 'medium',
      land_when: 'ci_pass',
      land_wait_minutes: 30,
      squash_on_merge: false,
      helper: 'lib/orchestrator/land.js',
    };
    const state = {
      phase: 'story_land',
      story_key: '4-12-foo',
      current_epic: '4',
    };
    const r = decorateRunScript(action, state, landProfile(), '/tmp/sp');
    expect(r.type).toBe('run_script');
    expect(Array.isArray(r.steps)).toBe(true);
    // Steps should be non-empty — at minimum a stack-snapshot and a
    // land-this-pr invocation.
    expect((r.steps as unknown[]).length).toBeGreaterThan(0);
    // The branch should be computed from story_key via gitPlan.branchName.
    expect(r.branch).toBe('story/4-12-foo');
  });

  it('leaves non-run_script actions untouched', () => {
    const gitOpAction = { type: 'git_op', op: 'commit_and_push_story' };
    const r = decorateRunScript(gitOpAction, {}, landProfile(), '/tmp/sp');
    expect(r).toBe(gitOpAction);
  });

  it('leaves run_script actions with other ops untouched', () => {
    const otherRunScript = { type: 'run_script', op: 'something_else', command: ['echo'] };
    const r = decorateRunScript(otherRunScript, {}, landProfile(), '/tmp/sp');
    expect(r).toBe(otherRunScript);
  });
});
