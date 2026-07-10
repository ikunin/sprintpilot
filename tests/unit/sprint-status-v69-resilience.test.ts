import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import autopilotMod from '../../_Sprintpilot/bin/autopilot.js';
// @ts-expect-error — CommonJS module
import verifyMod from '../../_Sprintpilot/lib/orchestrator/verify.js';
// @ts-expect-error — CommonJS module
import sprintPlanMod from '../../_Sprintpilot/scripts/sprint-plan.js';

const { storyStatusFromSprintStatus } = verifyMod as {
  storyStatusFromSprintStatus: (text: string, storyKey: string) => string | null;
};
const { readBmadStatuses } = sprintPlanMod as {
  readBmadStatuses: (projectRoot: string) => Map<string, string | null>;
};
const { parseSprintStatuses, looksLikeStoryKey } = autopilotMod as {
  parseSprintStatuses: (raw: string) => Record<string, unknown>;
  looksLikeStoryKey: (key: string) => boolean;
};

// BMad v6.9 moved retrospective action items into sprint-status.yaml. The exact
// schema is confirmed only against a live v6.9 install, so we bracket the two
// plausible shapes — a top-level `retrospectives:` block AND action items
// nested/adjacent to the story block — and assert every reader still yields
// exactly the real story→status map and never treats an action item as a story.
const V69_TOP_LEVEL = `development_status:
  1-1-foo: done  # PR #12 merged
  1-2-bar: in_progress
  1-3-baz: backlog
retrospectives:
  epic-1:
    action_items:
      - id: ai-1
        text: add ci gate
        status: open
      - id: ai-2
        text: fix flaky test
        status: done
`;

const V69_NESTED = `development_status:
  1-1-foo: done
  1-2-bar: in_progress
  action_items:
    - tighten logging
    - add ci gate
`;

const REAL_STORIES: Record<string, string> = {
  '1-1-foo': 'done',
  '1-2-bar': 'in_progress',
};

describe('sprint-status v6.9 action-item resilience', () => {
  let dir: string;
  const writeStatus = (raw: string) => {
    const art = join(dir, '_bmad-output', 'implementation-artifacts');
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, 'sprint-status.yaml'), raw, 'utf8');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-v69-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  for (const [name, raw] of [
    ['top-level retrospectives block', V69_TOP_LEVEL],
    ['nested action_items block', V69_NESTED],
  ] as const) {
    describe(name, () => {
      it('verify.js#storyStatusFromSprintStatus reads real story statuses unaffected by action items', () => {
        // Keyed lookup: the autopilot only ever queries a real state.story_key,
        // never an action-item id. The action-item block must not corrupt the
        // status resolved for a real story.
        for (const [key, status] of Object.entries(REAL_STORIES)) {
          expect(storyStatusFromSprintStatus(raw, key)).toBe(status);
        }
        expect(storyStatusFromSprintStatus(raw, 'ai-1')).toBeNull();
      });

      it('sprint-plan.js#readBmadStatuses maps only real stories', () => {
        writeStatus(raw);
        const map = readBmadStatuses(dir);
        for (const [key, status] of Object.entries(REAL_STORIES)) {
          expect(map.get(key)).toBe(status);
        }
        for (const key of [...map.keys()]) {
          expect(key).not.toMatch(/action|ai-\d/);
        }
      });

      it('autopilot.js consumers filter action items via looksLikeStoryKey', () => {
        const parsed = parseSprintStatuses(raw);
        // Whatever the parser surfaces, the story-key filter the consumers apply
        // keeps only real stories.
        const storyKeys = Object.keys(parsed).filter((k) => looksLikeStoryKey(k));
        expect(storyKeys).toEqual(expect.arrayContaining(Object.keys(REAL_STORIES)));
        expect(storyKeys).not.toContain('ai-1');
        expect(storyKeys).not.toContain('action_items');
      });
    });
  }
});
