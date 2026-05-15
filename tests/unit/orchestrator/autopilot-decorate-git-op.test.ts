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

describe('composeRuntimeState — migration of legacy current_bmad_step', () => {
  const medium = () => flatToProfile({}, 'medium');

  it('bumps create_story → prepare_story_branch on fresh sprint upgrade (no story signals)', () => {
    const r = composeRuntimeState({ current_bmad_step: 'create_story' }, medium());
    expect(r.phase).toBe('prepare_story_branch');
  });

  it('leaves create_story alone when current_story is set (mid-story)', () => {
    const r = composeRuntimeState(
      { current_bmad_step: 'create_story', current_story: 'S1.2' },
      medium(),
    );
    expect(r.phase).toBe('create_story');
  });

  it('migrates when story_file_path is set but the file does not exist (stale persist)', () => {
    // A persisted story_file_path can be optimistically written before
    // the skill actually creates the file (e.g. coalesce_state_writes).
    // The migration logic must check existence to avoid the false-
    // positive mid-story signal.
    const r = composeRuntimeState(
      { current_bmad_step: 'create_story', story_file_path: '/nope/does-not-exist.md' },
      medium(),
    );
    expect(r.phase).toBe('prepare_story_branch');
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
