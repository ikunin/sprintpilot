import { describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import autopilot from '../../_Sprintpilot/bin/autopilot.js';

type Task = {
  id: string;
  label: string;
  phases: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
};

const { STORY_TASK_DEFINITIONS, STORY_PHASE_ORDER, deriveTasksForStory, tasksToMarkdown } =
  autopilot as {
    STORY_TASK_DEFINITIONS: ReadonlyArray<{ id: string; label: string; phases: string[] }>;
    STORY_PHASE_ORDER: ReadonlyArray<string>;
    deriveTasksForStory: (
      currentPhase: string | null,
      recentLedgerEntries: Record<string, unknown>[],
      opts?: { haltActive?: boolean },
    ) => Task[];
    tasksToMarkdown: (
      story: string | null,
      tasks: Task[],
      opts?: { heading?: string },
    ) => string;
  };

// v2.3.12 — per-story canonical task list derivation. Pure function;
// no I/O. Exercises every status transition: pending → in_progress →
// completed, plus the failed-on-halt path.
describe('STORY_TASK_DEFINITIONS', () => {
  it('exposes the canonical 7 tasks in execution order', () => {
    expect(STORY_TASK_DEFINITIONS.length).toBe(7);
    const ids = STORY_TASK_DEFINITIONS.map((t) => t.id);
    expect(ids).toEqual([
      'create_story',
      'check_readiness',
      'dev_red',
      'dev_green',
      'code_review',
      'patch_apply_retest',
      'story_land',
    ]);
  });

  it('each task has a non-empty label and at least one phase mapping', () => {
    for (const t of STORY_TASK_DEFINITIONS) {
      expect(typeof t.label).toBe('string');
      expect(t.label.length).toBeGreaterThan(0);
      expect(Array.isArray(t.phases)).toBe(true);
      expect(t.phases.length).toBeGreaterThan(0);
      for (const p of t.phases) {
        expect(STORY_PHASE_ORDER).toContain(p);
      }
    }
  });
});

describe('deriveTasksForStory', () => {
  it('all tasks pending when no phase has started', () => {
    const tasks = deriveTasksForStory(null, []);
    expect(tasks.every((t) => t.status === 'pending')).toBe(true);
  });

  it('marks the task containing currentPhase as in_progress, prior tasks as completed', () => {
    const tasks = deriveTasksForStory('dev_green', []);
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t.status]));
    expect(byId.create_story).toBe('completed');
    expect(byId.check_readiness).toBe('completed');
    expect(byId.dev_red).toBe('completed');
    expect(byId.dev_green).toBe('in_progress');
    expect(byId.code_review).toBe('pending');
    expect(byId.patch_apply_retest).toBe('pending');
    expect(byId.story_land).toBe('pending');
  });

  it('patch_apply and patch_retest both map to the same combined task', () => {
    const inApply = deriveTasksForStory('patch_apply', []);
    const inRetest = deriveTasksForStory('patch_retest', []);
    const applyStatus = inApply.find((t) => t.id === 'patch_apply_retest')!.status;
    const retestStatus = inRetest.find((t) => t.id === 'patch_apply_retest')!.status;
    expect(applyStatus).toBe('in_progress');
    expect(retestStatus).toBe('in_progress');
  });

  it('story_done and story_land both map to the "Land story" task', () => {
    const inDone = deriveTasksForStory('story_done', []);
    const inLand = deriveTasksForStory('story_land', []);
    expect(inDone.find((t) => t.id === 'story_land')!.status).toBe('in_progress');
    expect(inLand.find((t) => t.id === 'story_land')!.status).toBe('in_progress');
  });

  it('flips current task to failed when halt is active and last signal was non-success', () => {
    const ledgerTail = [
      { kind: 'signal_recorded', phase: 'dev_red', status: 'blocked' },
    ];
    const tasks = deriveTasksForStory('dev_red', ledgerTail, { haltActive: true });
    const devRed = tasks.find((t) => t.id === 'dev_red')!;
    expect(devRed.status).toBe('failed');
  });

  it('keeps the task in_progress on halt when the last signal was user_input or success', () => {
    const ledgerTail = [{ kind: 'signal_recorded', phase: 'dev_red', status: 'user_input' }];
    const tasks = deriveTasksForStory('dev_red', ledgerTail, { haltActive: true });
    const devRed = tasks.find((t) => t.id === 'dev_red')!;
    expect(devRed.status).toBe('in_progress');
  });

  it('returns a stable shape (id, label, phases[], status) for every task', () => {
    const tasks = deriveTasksForStory('code_review', []);
    for (const t of tasks) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.label).toBe('string');
      expect(Array.isArray(t.phases)).toBe(true);
      expect(['pending', 'in_progress', 'completed', 'failed']).toContain(t.status);
    }
  });
});

describe('tasksToMarkdown', () => {
  it('renders a heading, story line, and one checkbox row per task', () => {
    const tasks = deriveTasksForStory('dev_red', []);
    const md = tasksToMarkdown('t-22a-test', tasks);
    expect(md).toMatch(/^# Sprintpilot/);
    expect(md).toContain('**Story:** `t-22a-test`');
    expect(md).toContain('- [x] Create story spec');
    expect(md).toContain('- [x] Check readiness');
    expect(md).toContain('- [ ] Write failing tests (RED) ← in progress');
    expect(md).toContain('- [ ] Implement to GREEN');
    expect(md).toContain('- [ ] Run code review');
    expect(md).toContain('- [ ] Apply review patches + retest');
    expect(md).toContain('- [ ] Land story (commit, push, merge)');
  });

  it('shows the failed glyph when a task is failed', () => {
    const tasks = deriveTasksForStory('dev_red', [
      { kind: 'signal_recorded', phase: 'dev_red', status: 'blocked' },
    ], { haltActive: true });
    const md = tasksToMarkdown('t-22a-test', tasks);
    expect(md).toContain('⚠ failed');
  });

  it('handles a null story (between stories) gracefully', () => {
    const md = tasksToMarkdown(null, deriveTasksForStory(null, []));
    expect(md).toContain('**Story:** (none — between stories or idle)');
  });
});
