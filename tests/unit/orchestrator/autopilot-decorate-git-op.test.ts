import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error — CommonJS module
import autopilot from '../../../_Sprintpilot/bin/autopilot.js';
// @ts-expect-error — CommonJS module
import profileRules from '../../../_Sprintpilot/lib/orchestrator/profile-rules.js';

const { decorateGitOp, composeRuntimeState } = autopilot as {
  decorateGitOp: (
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

  it('does NOT migrate phases past create_story (mid-cycle states)', () => {
    for (const phase of ['check_readiness', 'dev_red', 'dev_green', 'code_review']) {
      const r = composeRuntimeState({ current_bmad_step: phase }, medium());
      expect(r.phase).toBe(phase);
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
