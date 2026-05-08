// Regression tests for the three CRITICAL findings from the adversarial
// review of chunks 1–4:
//
//   1. mergeSprintStatus silently overrode `blocked` / `paused` / future
//      BMad statuses with `done`.
//   2. CRLF line endings and a UTF-8 BOM made every regex anchor fail,
//      returning null and causing git to leave conflict markers.
//   3. The block parsers required exactly two-space indent — a 4-space-
//      indented BMad file parsed with zero children, which then made
//      mergeSection silently overwrite the whole section.
//
// Each block below corresponds to one finding. If any of these starts
// failing again, the regression has returned.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import yamlMergeMod from '../../_Sprintpilot/lib/runtime/yaml-merge.js';

const { mergeAutopilotState, mergeDecisionLog, mergeGitStatus, mergeSprintStatus } =
  yamlMergeMod as {
    mergeAutopilotState: (a: string, o: string | null, b: string) => string | null;
    mergeDecisionLog: (a: string, o: string | null, b: string) => string | null;
    mergeGitStatus: (a: string, o: string | null, b: string) => string | null;
    mergeSprintStatus: (a: string, o: string | null, b: string) => string | null;
  };

describe('regression #1 — unknown status fallback in mergeSprintStatus', () => {
  it('preserves "blocked" on A when B says "done"', () => {
    const A = `epics:
  1:
    status: blocked
last_updated: "2026-04-15T10:00:00Z"
`;
    const B = `epics:
  1:
    status: done
last_updated: "2026-04-15T11:00:00Z"
`;
    const merged = mergeSprintStatus(A, '', B) || '';
    // Critical: blocked must survive; if the rank-based comparison silently
    // promotes done (rank 4) over blocked (rank -1), the user loses the
    // "human attention required" signal.
    expect(merged).toMatch(/1:\s*\n\s+status: blocked/);
    expect(merged).not.toMatch(/status: done/);
  });

  it('preserves a future status like "paused" on B when A is "review"', () => {
    const A = `epics:
  1:
    status: review
`;
    const B = `epics:
  1:
    status: paused
`;
    const merged = mergeSprintStatus(A, '', B) || '';
    // A's "review" is rank 3; B's "paused" is unknown (-1). Per the new
    // policy, A wins on doubt.
    expect(merged).toMatch(/status: review/);
  });

  it('still takes max status when BOTH sides are known', () => {
    const A = `epics:
  1:
    status: in-progress
`;
    const B = `epics:
  1:
    status: done
`;
    const merged = mergeSprintStatus(A, '', B) || '';
    expect(merged).toMatch(/status: done/);
  });

  it('does not advance when B is unknown even if A is rank 0 (backlog)', () => {
    const A = `development_status:
  1-1:
    status: backlog
`;
    const B = `development_status:
  1-1:
    status: cancelled
`;
    const merged = mergeSprintStatus(A, '', B) || '';
    // backlog is rank 0; cancelled is unknown. Policy: A wins on doubt.
    expect(merged).toMatch(/1-1:\s*\n\s+status: backlog/);
  });
});

describe('regression #2 — CRLF and BOM normalization', () => {
  it('mergeAutopilotState handles CRLF inputs', () => {
    const A = `last_updated: "2026-04-15T10:00:00Z"\r\ncurrent_story: "1-1"\r\n`;
    const B = `last_updated: "2026-04-15T11:00:00Z"\r\ncurrent_story: "1-2"\r\n`;
    const merged = mergeAutopilotState(A, '', B) || '';
    // B is later; merge driver should pick B (which still has CRLF —
    // normalization is a parse-time concern, output preserves the original).
    expect(merged).toContain('1-2');
  });

  it('mergeGitStatus parses CRLF input rather than returning null', () => {
    const A = `# header\r\nstories:\r\n  1-1:\r\n    branch: story/1-1\r\n    last_updated: "2026-04-15T10:00:00Z"\r\n`;
    const B = `# header\r\nstories:\r\n  1-2:\r\n    branch: story/1-2\r\n    last_updated: "2026-04-15T11:00:00Z"\r\n`;
    const merged = mergeGitStatus(A, '', B);
    expect(merged).not.toBe(null);
    expect(merged).toMatch(/1-1:/);
    expect(merged).toMatch(/1-2:/);
  });

  it('mergeDecisionLog parses input with a leading UTF-8 BOM', () => {
    const A =
      '﻿' +
      `last_updated: "2026-04-15T10:00:00Z"\n\ndecisions:\n  - id: "1"\n    ts: "2026-04-15T09:00:00Z"\n`;
    const B = `last_updated: "2026-04-15T11:00:00Z"\n\ndecisions:\n  - id: "2"\n    ts: "2026-04-15T10:00:00Z"\n`;
    const merged = mergeDecisionLog(A, '', B);
    expect(merged).not.toBe(null);
    expect(merged).toMatch(/id: "1"/);
    expect(merged).toMatch(/id: "2"/);
  });

  it('mergeSprintStatus parses CRLF + BOM together', () => {
    const A =
      '﻿' + `epics:\r\n  1:\r\n    status: in-progress\r\nlast_updated: "2026-04-15T10:00:00Z"\r\n`;
    const B = `epics:\r\n  1:\r\n    status: review\r\nlast_updated: "2026-04-15T11:00:00Z"\r\n`;
    const merged = mergeSprintStatus(A, '', B);
    expect(merged).not.toBe(null);
    expect(merged).toMatch(/status: review/);
    expect(merged).toMatch(/last_updated: "2026-04-15T11:00:00Z"/);
  });
});

describe('regression #3 — indent flexibility in block parsers', () => {
  it('mergeSprintStatus handles 4-space-indented epics section', () => {
    const A = `epics:
    1:
        status: in-progress
last_updated: "2026-04-15T10:00:00Z"
`;
    const B = `epics:
    1:
        status: review
    2:
        status: backlog
last_updated: "2026-04-15T11:00:00Z"
`;
    const merged = mergeSprintStatus(A, '', B) || '';
    // Critical: previously this silently dropped the entire epics: section
    // because parseTopLevelSection's 2-space-only regex parsed zero
    // children. Now it accepts the detected 4-space indent.
    expect(merged).toMatch(/1:\s*\n\s+status: review/);
    expect(merged).toMatch(/2:/);
    expect(merged).toMatch(/last_updated: "2026-04-15T11:00:00Z"/);
  });

  it('mergeGitStatus handles 4-space-indented stories section', () => {
    const A = `git_integration:
  enabled: true

stories:
    1-1:
        branch: story/1-1
        last_updated: "2026-04-15T10:00:00Z"
`;
    const B = `git_integration:
  enabled: true

stories:
    1-1:
        branch: story/1-1
        pr_url: https://github.com/x/y/pull/1
        last_updated: "2026-04-15T12:00:00Z"
    1-2:
        branch: story/1-2
        last_updated: "2026-04-15T11:00:00Z"
`;
    const merged = mergeGitStatus(A, '', B);
    expect(merged).not.toBe(null);
    expect(merged).toMatch(/1-1:/);
    expect(merged).toMatch(/1-2:/);
    expect(merged).toMatch(/pr_url: https:\/\/github\.com\/x\/y\/pull\/1/);
  });

  it('mergeDecisionLog handles 4-space-indented list items', () => {
    const A = `last_updated: "2026-04-15T10:00:00Z"

decisions:
    - id: "1"
      ts: "2026-04-15T09:00:00Z"
      decision: "first"
`;
    const B = `last_updated: "2026-04-15T11:00:00Z"

decisions:
    - id: "2"
      ts: "2026-04-15T10:00:00Z"
      decision: "second"
`;
    const merged = mergeDecisionLog(A, '', B);
    expect(merged).not.toBe(null);
    expect(merged).toMatch(/id: "1"/);
    expect(merged).toMatch(/id: "2"/);
  });

  it('mergeSprintStatus does not erase epics section on bad parse (defense-in-depth)', () => {
    // Before the fix: 4-space indent → zero children → mergeSection wrote
    // back "epics:\n" with no entries, silently erasing both sides' data.
    // Now it should preserve at least A's content.
    const A = `epics:
    1:
        status: in-progress
        title: "Auth refactor"
        owner: alice
`;
    const B = `epics:
    1:
        status: in-progress
        title: "Auth refactor"
        owner: bob
`;
    const merged = mergeSprintStatus(A, '', B) || '';
    expect(merged).toMatch(/title: "Auth refactor"/);
    expect(merged).toMatch(/status: in-progress/);
  });
});
