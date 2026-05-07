import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import yamlMergeMod from '../../_Sprintpilot/lib/runtime/yaml-merge.js';

const {
  STATUS_ORDER,
  statusRank,
  compareTs,
  mergeAutopilotState,
  mergeDecisionLog,
  mergeGitStatus,
  mergeSprintStatus,
  mergerForFilename,
} = yamlMergeMod as {
  STATUS_ORDER: string[];
  statusRank: (s: string | null) => number;
  compareTs: (a: string | null, b: string | null) => number;
  mergeAutopilotState: (a: string, o: string | null, b: string) => string | null;
  mergeDecisionLog: (a: string, o: string | null, b: string) => string | null;
  mergeGitStatus: (a: string, o: string | null, b: string) => string | null;
  mergeSprintStatus: (a: string, o: string | null, b: string) => string | null;
  mergerForFilename: (filename: string) => unknown;
};

describe('STATUS_ORDER', () => {
  it('orders backlog → done', () => {
    expect(STATUS_ORDER).toEqual([
      'backlog',
      'ready-for-dev',
      'in-progress',
      'review',
      'done',
    ]);
  });

  it('statusRank handles unknown strings', () => {
    expect(statusRank('done')).toBe(4);
    expect(statusRank('backlog')).toBe(0);
    expect(statusRank('garbage')).toBe(-1);
    expect(statusRank(null)).toBe(-1);
  });
});

describe('compareTs', () => {
  it('orders ISO timestamps', () => {
    expect(compareTs('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).toBe(-1);
    expect(compareTs('2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(1);
    expect(compareTs('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(0);
  });

  it('treats null as earliest', () => {
    expect(compareTs(null, '2026-01-01T00:00:00Z')).toBe(-1);
    expect(compareTs('2026-01-01T00:00:00Z', null)).toBe(1);
    expect(compareTs(null, null)).toBe(0);
  });
});

describe('mergerForFilename', () => {
  it('routes by basename', () => {
    expect(typeof mergerForFilename('/x/sprint-status.yaml')).toBe('function');
    expect(typeof mergerForFilename('git-status.yaml')).toBe('function');
    expect(typeof mergerForFilename('decision-log.yaml')).toBe('function');
    expect(typeof mergerForFilename('autopilot-state.yaml')).toBe('function');
    expect(mergerForFilename('unknown.yaml')).toBe(null);
  });
});

describe('mergeAutopilotState', () => {
  const A = `last_updated: "2026-04-15T12:00:00Z"
current_story: "1-1"
current_bmad_step: dev-story-green
`;
  const B = `last_updated: "2026-04-15T13:00:00Z"
current_story: "1-2"
current_bmad_step: code-review
`;

  it('takes the side with later last_updated', () => {
    expect(mergeAutopilotState(A, '', B)).toBe(B);
    expect(mergeAutopilotState(B, '', A)).toBe(B);
  });

  it('ties favor A (current side)', () => {
    const tied = `last_updated: "2026-04-15T12:00:00Z"\ndifferent: yes\n`;
    expect(mergeAutopilotState(A, '', tied)).toBe(A);
  });

  it('handles missing files', () => {
    expect(mergeAutopilotState('', null, B)).toBe(B);
    expect(mergeAutopilotState(A, null, '')).toBe(A);
    expect(mergeAutopilotState('', null, '')).toBe('');
  });
});

describe('mergeDecisionLog', () => {
  const A = `# Sprintpilot — Decision Log
last_updated: "2026-04-15T12:00:00Z"

decisions:
  - id: "1"
    phase: autopilot:setup
    category: choice
    decision: "use medium profile"
    rationale: "default"
    impact: low
    story: "1-1"
    ts: "2026-04-15T10:00:00Z"
  - id: "2"
    phase: autopilot:dev
    category: workaround
    decision: "skip flaky test"
    rationale: "blocked"
    impact: low
    story: "1-2"
    ts: "2026-04-15T11:00:00Z"
`;

  const B = `# Sprintpilot — Decision Log
last_updated: "2026-04-15T14:00:00Z"

decisions:
  - id: "1"
    phase: autopilot:setup
    category: choice
    decision: "use medium profile"
    rationale: "default"
    impact: low
    story: "1-1"
    ts: "2026-04-15T10:00:00Z"
  - id: "3"
    phase: autopilot:retro
    category: choice
    decision: "extend session limit"
    rationale: "small story stack"
    impact: medium
    story: "epic-1"
    ts: "2026-04-15T13:00:00Z"
`;

  it('unions disjoint id sets', () => {
    const merged = mergeDecisionLog(A, '', B);
    expect(merged).toBeTruthy();
    expect(merged).toMatch(/- id: "1"/);
    expect(merged).toMatch(/- id: "2"/);
    expect(merged).toMatch(/- id: "3"/);
  });

  it('updates last_updated to the newer side', () => {
    const merged = mergeDecisionLog(A, '', B);
    expect(merged).toMatch(/last_updated: "2026-04-15T14:00:00Z"/);
  });

  it('orders entries by ts ascending', () => {
    const merged = mergeDecisionLog(A, '', B) || '';
    const idxOf = (s: string) => merged.indexOf(s);
    expect(idxOf('id: "1"')).toBeLessThan(idxOf('id: "2"'));
    expect(idxOf('id: "2"')).toBeLessThan(idxOf('id: "3"'));
  });

  it('on conflicting id takes later ts', () => {
    const aWithOldTs = A;
    const bWithNewerSameId = `# Sprintpilot — Decision Log
last_updated: "2026-04-15T15:00:00Z"

decisions:
  - id: "2"
    phase: autopilot:dev
    category: choice
    decision: "different decision body"
    rationale: "newer ts"
    impact: high
    story: "1-2"
    ts: "2026-04-15T15:00:00Z"
`;
    const merged = mergeDecisionLog(aWithOldTs, '', bWithNewerSameId) || '';
    expect(merged).toMatch(/different decision body/);
    expect(merged).not.toMatch(/skip flaky test/);
  });

  it('refuses to merge when decisions: section is absent on either side', () => {
    expect(mergeDecisionLog('garbage: yes\n', '', A)).toBe(null);
    expect(mergeDecisionLog(A, '', 'garbage: yes\n')).toBe(null);
  });
});

describe('mergeGitStatus', () => {
  const HEADER = `# Sprintpilot — Git Status
git_integration:
  enabled: true
  base_branch: main
  platform: github

stories:
`;

  const A = `${HEADER}  1-1:
    branch: story/1-1
    push_status: pushed
    last_updated: "2026-04-15T10:00:00Z"
  1-2:
    branch: story/1-2
    push_status: pending
    last_updated: "2026-04-15T11:00:00Z"
`;

  const B = `${HEADER}  1-1:
    branch: story/1-1
    push_status: pushed
    pr_url: https://github.com/x/y/pull/1
    last_updated: "2026-04-15T12:00:00Z"
  1-3:
    branch: story/1-3
    push_status: pushed
    last_updated: "2026-04-15T13:00:00Z"
`;

  it('unions stories from both sides', () => {
    const merged = mergeGitStatus(A, '', B) || '';
    expect(merged).toMatch(/1-1:/);
    expect(merged).toMatch(/1-2:/);
    expect(merged).toMatch(/1-3:/);
  });

  it('on overlapping story takes later last_updated', () => {
    const merged = mergeGitStatus(A, '', B) || '';
    expect(merged).toMatch(/pr_url: https:\/\/github\.com\/x\/y\/pull\/1/);
  });

  it('preserves the header from A', () => {
    const merged = mergeGitStatus(A, '', B) || '';
    expect(merged).toMatch(/# Sprintpilot — Git Status/);
    expect(merged).toMatch(/git_integration:/);
  });

  it('refuses to merge when stories: header is absent', () => {
    expect(mergeGitStatus('hello\n', '', A)).toBe(null);
  });
});

describe('mergeSprintStatus', () => {
  const A = `sprint:
  name: "fixture-epic-1"

epics:
  1:
    status: in-progress

development_status:
  1-1-data-model:
    status: in-progress
  1-2-user-profile:
    status: ready-for-dev
last_updated: "2026-04-15T10:00:00Z"
`;

  const B = `sprint:
  name: "fixture-epic-1"

epics:
  1:
    status: review

development_status:
  1-1-data-model:
    status: done
  1-3-avatar:
    status: backlog
last_updated: "2026-04-15T12:00:00Z"
`;

  it('takes max status per epic', () => {
    const merged = mergeSprintStatus(A, '', B) || '';
    // epic 1: in-progress (A) vs review (B) → review wins
    expect(merged).toMatch(/1:\s*\n\s+status: review/);
  });

  it('takes max status per development_status story', () => {
    const merged = mergeSprintStatus(A, '', B) || '';
    // 1-1-data-model: in-progress (A) vs done (B) → done wins
    const m = merged.match(/1-1-data-model:\s*\n\s+status: (\S+)/);
    expect(m?.[1]).toBe('done');
  });

  it('unions stories: includes new keys from B', () => {
    const merged = mergeSprintStatus(A, '', B) || '';
    expect(merged).toMatch(/1-3-avatar:/);
    expect(merged).toMatch(/1-2-user-profile:/);
  });

  it('updates last_updated to the newer side', () => {
    const merged = mergeSprintStatus(A, '', B) || '';
    expect(merged).toMatch(/last_updated: "2026-04-15T12:00:00Z"/);
  });

  it('keeps lower status when A is more progressed', () => {
    const Aplus = A.replace('status: in-progress\n\ndevelopment_status', 'status: done\n\ndevelopment_status');
    const merged = mergeSprintStatus(Aplus, '', B) || '';
    expect(merged).toMatch(/1:\s*\n\s+status: done/);
  });
});
