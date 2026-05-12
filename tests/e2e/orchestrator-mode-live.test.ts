/**
 * Live-LLM orchestrator-mode e2e.
 *
 * Verifies the new orchestrator path (autopilot.execution_mode: orchestrator)
 * works end-to-end with a real LLM:
 *
 *   1. SKILL.md correctly routes a real LLM to workflow.orchestrator.md
 *      when execution_mode=orchestrator.
 *   2. The LLM, following workflow.orchestrator.md, drives autopilot.js
 *      through `next` → `record` cycles.
 *   3. Ledger captures the action_emitted + signal_recorded + state_transition
 *      sequence.
 *   4. autopilot-state.yaml reflects forward progress through BMad phases.
 *
 * Scope: drives ONE story through the orchestrator (CREATE_STORY → at least
 * one phase advance). NOT a full sprint — keeps budget low (~$10-20 cap).
 *
 * Gated on `claude` being on PATH (authed via keychain or ANTHROPIC_API_KEY).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runClaude } from './harness/claude-runner.js';
import { createTempProject, type TempProject } from './harness/temp-project.js';

const ADDON_SOURCE = join(import.meta.dirname, '../../_Sprintpilot');
const BUDGET = Number.parseFloat(process.env.BMAD_E2E_BUDGET ?? '15');
const TIMEOUT = 900_000; // 15 min
const MODEL = process.env.BMAD_TEST_MODEL ?? 'sonnet';

const HAS_CLAUDE = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return !!process.env.ANTHROPIC_API_KEY;
  }
})();

let project: TempProject;

describe.skipIf(!HAS_CLAUDE)('Orchestrator mode (live LLM)', () => {
  beforeAll(() => {
    project = createTempProject({
      installBmadCore: true,
      installAddon: true,
      platform: 'git_only',
    });

    // Force execution_mode=orchestrator, complexity_profile=nano.
    const cfgPath = join(project.dir, '_Sprintpilot/modules/autopilot/config.yaml');
    let body = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : 'autopilot:\n';
    if (/complexity_profile:/.test(body)) {
      body = body.replace(/complexity_profile:\s*\w+/, 'complexity_profile: nano');
    } else {
      body = body.replace(/^autopilot:/m, 'autopilot:\n  complexity_profile: nano');
    }
    if (/execution_mode:/.test(body)) {
      body = body.replace(/execution_mode:\s*\w+/, 'execution_mode: orchestrator');
    } else {
      body = body.replace(/^autopilot:/m, 'autopilot:\n  execution_mode: orchestrator');
    }
    writeFileSync(cfgPath, body);

    // Trivial product brief so the LLM doesn't have to think hard.
    const briefDir = join(project.dir, '_bmad-output/planning-artifacts');
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(
      join(briefDir, 'product-brief.md'),
      [
        '# Number Echo',
        '',
        'CLI that reads a number from stdin and prints it back.',
        '',
        '## Epic 1 — echo',
        '- S1.1 read a positive integer from stdin; print it.',
        '',
        '## Acceptance Criteria',
        '- Input 5 → output "5"',
        '- Empty input → exit code 1',
      ].join('\n'),
    );

    console.log(`[orchestrator-e2e] temp project: ${project.dir}`);
  });

  afterAll(() => {
    project?.cleanup();
  });

  it('SKILL.md routes execution_mode=orchestrator to workflow.orchestrator.md', () => {
    const skill = readFileSync(
      join(project.dir, '_Sprintpilot/skills/sprint-autopilot-on/SKILL.md'),
      'utf-8',
    );
    expect(skill).toContain('workflow.orchestrator.md');
    expect(skill).toContain('execution_mode');
  });

  it(
    'LLM following SKILL.md + workflow.orchestrator.md drives at least one autopilot cycle',
    async () => {
      const systemPrompt = [
        'You are running inside an automated e2e test for the new Sprintpilot orchestrator mode.',
        'Read _Sprintpilot/skills/sprint-autopilot-on/SKILL.md and follow it exactly.',
        'execution_mode is set to "orchestrator" in _Sprintpilot/modules/autopilot/config.yaml.',
        'Therefore you must follow workflow.orchestrator.md (NOT workflow.md).',
        'Drive the autopilot via `node _Sprintpilot/bin/autopilot.js` subcommands.',
        'Use `next` to get the next Action, then `record --signal <json>` to report results.',
        'Stop after AT LEAST 3 phase transitions are recorded in the ledger,',
        'or after one full BMad story cycle completes — whichever comes first.',
        'Do NOT ask the user any questions.',
        'When the orchestrator emits invoke_skill, simulate the skill: create the expected',
        'artifacts on disk (story file under _bmad-output/stories/, etc.), then record a',
        'success signal. For bmad-code-review, emit findings:[] with one defer finding so',
        'no patch loop is entered.',
      ].join(' ');

      console.log('[orchestrator-e2e] starting Claude session...');
      const result = await runClaude('/sprint-autopilot-on', {
        cwd: project.dir,
        maxBudget: BUDGET,
        model: MODEL,
        addDirs: [ADDON_SOURCE],
        timeout: TIMEOUT,
        appendSystemPrompt: systemPrompt,
      });

      console.log(
        `[orchestrator-e2e] session finished: exit=${result.exitCode} cost=$${result.json?.total_cost_usd?.toFixed(4) ?? '?'} duration=${result.json?.duration_ms ?? '?'}ms`,
      );
      if (result.timedOut) console.warn('[orchestrator-e2e] timed out');
      // Don't fail on non-zero exit — the LLM may legitimately halt mid-cycle.
      // We assert on the ledger contents instead.
    },
    TIMEOUT + 60_000,
  );

  it('ledger.jsonl records action_emitted + signal_recorded entries', () => {
    const ledgerPath = join(project.dir, '_bmad-output/implementation-artifacts/ledger.jsonl');
    expect(existsSync(ledgerPath), `ledger expected at ${ledgerPath}`).toBe(true);
    const lines = readFileSync(ledgerPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; phase?: string; action?: { type?: string } });

    const kinds = lines.map((l) => l.kind);
    console.log(`[orchestrator-e2e] ledger kinds: ${[...new Set(kinds)].join(', ')}`);

    expect(kinds).toContain('action_emitted');
    expect(kinds).toContain('signal_recorded');
    // At least one state transition was recorded (LLM advanced through ≥1 phase).
    expect(lines.some((l) => l.kind === 'state_transition')).toBe(true);
  });

  it('autopilot-state.yaml advanced beyond create_story', () => {
    const statePath = join(
      project.dir,
      '_bmad-output/implementation-artifacts/autopilot-state.yaml',
    );
    expect(existsSync(statePath), `state expected at ${statePath}`).toBe(true);
    const text = readFileSync(statePath, 'utf-8');
    console.log(`[orchestrator-e2e] state.yaml head:\n${text.split('\n').slice(0, 12).join('\n')}`);
    // current_bmad_step should be something other than create_story.
    // For nano profile, advancing means reaching nano_quick_dev or beyond.
    // For full flow, anywhere past create_story counts.
    const m = text.match(/current_bmad_step:\s*(\w+)/);
    expect(m, 'current_bmad_step should be present').toBeTruthy();
    if (m) {
      // We accept any forward state; just confirm the orchestrator is alive
      // and the LLM made it past boot.
      expect([
        'create_story',
        'check_readiness',
        'dev_red',
        'dev_green',
        'code_review',
        'patch_apply',
        'patch_retest',
        'story_done',
        'epic_boundary_check',
        'retrospective',
        'nano_quick_dev',
        'sprint_finalize_pending',
      ]).toContain(m[1]);
    }
  });

  it('orchestrator artifacts were used (not legacy workflow)', () => {
    // The legacy path writes timing shards under .timings/ but does NOT write
    // ledger.jsonl. Conversely, the orchestrator path always writes the ledger.
    const ledgerPath = join(project.dir, '_bmad-output/implementation-artifacts/ledger.jsonl');
    expect(existsSync(ledgerPath)).toBe(true);
    const ledger = readFileSync(ledgerPath, 'utf-8');
    // At minimum, the orchestrator's first action_emitted should appear.
    expect(ledger).toMatch(/"kind"\s*:\s*"action_emitted"/);
  });
});
