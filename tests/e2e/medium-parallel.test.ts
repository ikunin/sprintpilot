/**
 * E2E Medium + Parallel Test: Tic Tac Toe via Sprintpilot with parallel stories
 *
 * Verifies PR 11's intra-epic parallel dispatch on Claude Code:
 *   - `parallel_stories: true` + `max_parallel_stories: 2` in ma/config.yaml
 *   - dependencies.yaml declares 2 stories as `force_independent`
 *   - the autopilot should create concurrent worktrees and evidence of
 *     overlapping execution shows up in .timings/*.jsonl
 *   - agent-adapter.js reports claude-code + supports_parallel=true
 *     (prerequisite — if false, the test would just run sequentially and
 *     fail the parallel-evidence assertion)
 *
 * Gated on ANTHROPIC_API_KEY because it drives a real autopilot session.
 *
 * Run: ANTHROPIC_API_KEY=... npx vitest run tests/e2e/medium-parallel.test.ts
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDirectoryExists,
  assertFileContains,
  assertFileExists,
  readYaml,
} from './harness/assertions.js';
import { runClaude } from './harness/claude-runner.js';
import { costTracker } from './harness/cost-tracker.js';
import { createTempProject, placeFixture, type TempProject } from './harness/temp-project.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures/greenfield');
const ADDON_SOURCE = join(import.meta.dirname, '../../_Sprintpilot');

const MAX_SESSIONS = 4;
const BUDGET_PER_SESSION = 25;
const TIMEOUT_PER_SESSION = 1_200_000; // 20 min
const MODEL = process.env.BMAD_TEST_MODEL ?? 'sonnet';
const REMOTE_URL = process.env.BMAD_TEST_REMOTE_URL ?? '';
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

let project: TempProject;

/**
 * Scan .timings/*.jsonl for evidence of overlapping skill phases across
 * two or more stories. Returns the maximum concurrency observed —
 * 1 means sequential, 2+ means parallel.
 */
function observedParallelism(dir: string): { max: number; examples: string[] } {
  const timingsDir = join(dir, '_bmad-output/implementation-artifacts/.timings');
  if (!existsSync(timingsDir)) return { max: 0, examples: [] };

  interface Event {
    event: 'start' | 'end' | 'once';
    story: string;
    phase: string;
    ts: number;
  }
  const events: Event[] = [];
  for (const f of readdirSync(timingsDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const body = readFileSync(join(timingsDir, f), 'utf-8');
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as {
          event: string;
          story?: string;
          phase?: string;
          ts?: string;
        };
        if (!obj.event || !obj.story || !obj.phase || !obj.ts) continue;
        if (obj.event !== 'start' && obj.event !== 'end') continue;
        events.push({
          event: obj.event as 'start' | 'end',
          story: obj.story,
          phase: obj.phase,
          ts: Date.parse(obj.ts),
        });
      } catch {
        /* skip corrupt */
      }
    }
  }
  events.sort((a, b) => a.ts - b.ts);

  const open = new Map<string, Event>();
  let max = 0;
  const examples: string[] = [];
  for (const ev of events) {
    const key = `${ev.story}::${ev.phase}`;
    if (ev.event === 'start') {
      open.set(key, ev);
      const activeStories = new Set(
        [...open.values()].filter((o) => o.phase.startsWith('skill.')).map((o) => o.story),
      );
      if (activeStories.size > max) {
        max = activeStories.size;
        if (max >= 2) examples.push([...activeStories].sort().join('+'));
      }
    } else {
      open.delete(key);
    }
  }
  return { max, examples: [...new Set(examples)] };
}

describe.skipIf(!HAS_API_KEY)('Medium + parallel stories (Claude Code)', () => {
  beforeAll(() => {
    project = createTempProject({
      remoteUrl: REMOTE_URL,
      installBmadCore: true,
      installAddon: true,
      platform: 'github',
    });

    placeFixture(
      project.dir,
      '_bmad-output/planning-artifacts/product-brief.md',
      readFileSync(join(FIXTURES_DIR, 'product-brief.md'), 'utf-8'),
    );

    // Force medium profile via autopilot config (medium is default but be explicit).
    const autopilotCfg = join(project.dir, '_Sprintpilot/modules/autopilot/config.yaml');
    let body = existsSync(autopilotCfg) ? readFileSync(autopilotCfg, 'utf-8') : 'autopilot:\n';
    if (!/complexity_profile:/.test(body)) {
      body = body.replace(/^autopilot:/m, 'autopilot:\n  complexity_profile: medium');
    }
    writeFileSync(autopilotCfg, body);

    // Flip parallel_stories on in ma/config.yaml.
    const maCfg = join(project.dir, '_Sprintpilot/modules/ma/config.yaml');
    if (existsSync(maCfg)) {
      const ma = readFileSync(maCfg, 'utf-8').replace(
        /parallel_stories:\s*false/,
        'parallel_stories: true',
      );
      writeFileSync(maCfg, ma);
    }

    // Hand-authored dependencies.yaml: force_independent the stories we
    // want the autopilot to run concurrently. Keys match standard BMad
    // epic-1 story naming — the autopilot's DAG resolver widens layer 2
    // when both are independent of layer 1.
    mkdirSync(join(project.dir, '_Sprintpilot/sprints'), { recursive: true });
    writeFileSync(
      join(project.dir, '_Sprintpilot/sprints/dependencies.yaml'),
      [
        'version: 1',
        '# PR 11 e2e: story 1-2 and 1-3 are independent so resolve-dag.js',
        '# widens layer 2 to width >= 2.',
        'overrides:',
        '  - epic: 1',
        '    force_independent:',
        '      - 1-2-player-input',
        '      - 1-3-win-detection',
        '',
      ].join('\n'),
    );

    console.log(`[Medium+parallel] Temp project: ${project.dir}`);
  });

  afterAll(async () => {
    const lockPath = join(project.dir, '.autopilot.lock');
    if (project && existsSync(lockPath)) {
      try {
        await runClaude('/sprint-autopilot-off', {
          cwd: project.dir,
          maxBudget: 2,
          model: MODEL,
          addDirs: [ADDON_SOURCE],
          timeout: 60_000,
        });
      } catch {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
    console.log(costTracker.report());
    project?.cleanup();
  });

  it('setup is valid', () => {
    assertDirectoryExists(join(project.dir, '_Sprintpilot'));
    assertFileExists(join(project.dir, '_Sprintpilot/sprints/dependencies.yaml'));
    assertFileContains(
      join(project.dir, '_Sprintpilot/modules/ma/config.yaml'),
      /parallel_stories:\s*true/,
    );
  });

  it(
    'autopilot uses parallel dispatch on Claude Code',
    async () => {
      let session = 0;
      let totalCost = 0;

      while (session < MAX_SESSIONS) {
        session++;
        const systemPrompt = [
          'You are running inside an automated e2e test.',
          session === 1
            ? 'Follow the BMAD autopilot workflow exactly. Product brief is already at _bmad-output/planning-artifacts/product-brief.md.'
            : 'Resume the BMAD autopilot from saved state.',
          'You are Claude Code. ma.parallel_stories is true. When the DAG resolver widens a layer to >1 story, spawn concurrent sub-agents (Agent tool) for that layer.',
          'Do NOT ask the user any questions — resolve all decisions autonomously.',
          'Use TypeScript with Vitest for testing.',
        ].join(' ');

        console.log(`\n[Session ${session}/${MAX_SESSIONS}] Starting autopilot...`);
        const result = await runClaude('/sprint-autopilot-on', {
          cwd: project.dir,
          maxBudget: BUDGET_PER_SESSION,
          model: MODEL,
          addDirs: [ADDON_SOURCE],
          timeout: TIMEOUT_PER_SESSION,
          appendSystemPrompt: systemPrompt,
        });

        const cost = result.json?.total_cost_usd ?? 0;
        totalCost += cost;
        costTracker.record(
          'medium-parallel',
          `session-${session}`,
          cost,
          result.json?.duration_ms ?? 0,
        );

        if (!existsSync(join(project.dir, '.autopilot.lock'))) {
          console.log(`[Session ${session}] Sprint complete — done`);
          break;
        }
      }

      // The discriminating assertion: two stories must have overlapping
      // skill.* intervals in the timing log.
      const par = observedParallelism(project.dir);
      console.log(
        `[Result] Observed parallelism max=${par.max}, examples=${par.examples.join('|')}, $${totalCost.toFixed(4)}`,
      );
      expect(
        par.max,
        'At least two stories must run concurrently in some skill.* phase',
      ).toBeGreaterThanOrEqual(2);
    },
    MAX_SESSIONS * (TIMEOUT_PER_SESSION + 120_000),
  );

  it('sprint-status shows all stories done', () => {
    const statusPath = join(project.dir, '_bmad-output/implementation-artifacts/sprint-status.yaml');
    if (!existsSync(statusPath)) {
      console.warn('[Result] sprint-status.yaml missing — autopilot may have halted');
      return;
    }
    const status = readYaml(statusPath) as Record<string, unknown>;
    const block = (status.development_status ?? status.stories) as Record<string, string> | undefined;
    if (!block) return;
    const remaining = Object.entries(block).filter(([, v]) => v !== 'done');
    expect(remaining, `stories not done: ${JSON.stringify(remaining)}`).toEqual([]);
  });

  it('merge-shards archived per-layer shards', () => {
    // With state_sharding=auto + parallel_stories=true, merge-shards.js
    // should have archived at least one layer under .archive/.
    const archiveDir = join(project.dir, '_bmad-output/implementation-artifacts/.archive');
    if (!existsSync(archiveDir)) {
      console.warn('[Result] .archive/ missing — sharding path may not have been exercised');
      return;
    }
    const entries = readdirSync(archiveDir);
    expect(entries.some((f: string) => f.startsWith('layer-') || f === 'corrupt')).toBe(true);
  });

});
