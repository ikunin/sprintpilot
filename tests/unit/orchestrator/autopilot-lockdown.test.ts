import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Legacy-workflow lockdown: v2.1+ installs do not ship `workflow.md` —
 * only `workflow.legacy.md.bak` is present. But upgrades from v2.0.x
 * may still have a `workflow.md` left over. When execution_mode=
 * orchestrator (the v2.1+ default), the autopilot CLI moves any
 * surviving `workflow.md` aside on `start` so the LLM under
 * `/sprint-autopilot-on` cannot silently fall back to the legacy
 * 1,388-line prose workflow.
 *
 * Tested as an integration: synthesize the v2.0.x-style layout
 * (workflow.md present), invoke `autopilot start`, and assert
 * filesystem state.
 */

const CLI = join(__dirname, '..', '..', '..', '_Sprintpilot', 'bin', 'autopilot.js');
const REPO_ROOT = join(__dirname, '..', '..', '..');
const LEGACY_WORKFLOW_STUB = '# legacy workflow stub for lockdown tests\n';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sp-lockdown-'));
  // Copy _Sprintpilot/ (so the addon dir mirrors a real install).
  const dest = join(projectRoot, '_Sprintpilot');
  mkdirSync(dest, { recursive: true });
  for (const sub of ['scripts', 'lib', 'modules', 'skills']) {
    execFileSync('cp', ['-R', join(REPO_ROOT, '_Sprintpilot', sub), join(dest, sub)]);
  }
  // Simulate a v2.0.x install: synthesize a stale `workflow.md` in both
  // skill locations. The addon source itself no longer ships it (only
  // `workflow.legacy.md.bak`), so we plant a stub the lockdown can move.
  const addonSkill = join(dest, 'skills', 'sprint-autopilot-on');
  writeFileSync(join(addonSkill, 'workflow.md'), LEGACY_WORKFLOW_STUB);

  // Also seed `.claude/skills/sprint-autopilot-on/` with the workflow files
  // — that's the location the LLM actually reads under Claude Code.
  const userSkill = join(projectRoot, '.claude', 'skills', 'sprint-autopilot-on');
  mkdirSync(userSkill, { recursive: true });
  for (const f of ['SKILL.md', 'workflow.orchestrator.md']) {
    const src = join(REPO_ROOT, '_Sprintpilot', 'skills', 'sprint-autopilot-on', f);
    if (existsSync(src)) {
      writeFileSync(join(userSkill, f), readFileSync(src, 'utf-8'));
    }
  }
  writeFileSync(join(userSkill, 'workflow.md'), LEGACY_WORKFLOW_STUB);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function setExecutionMode(mode: 'orchestrator' | 'legacy') {
  const cfgDir = join(projectRoot, '_Sprintpilot', 'modules', 'autopilot');
  writeFileSync(
    join(cfgDir, 'config.yaml'),
    `complexity_profile: medium\nautopilot:\n  execution_mode: ${mode}\n`,
    'utf-8',
  );
}

function cli(args: string[]) {
  try {
    const stdout = execFileSync('node', [CLI, ...args, '--project-root', projectRoot], {
      encoding: 'utf-8',
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout || '', status: err.status ?? 1 };
  }
}

const userSkillDir = () => join(projectRoot, '.claude', 'skills', 'sprint-autopilot-on');
const addonSkillDir = () => join(projectRoot, '_Sprintpilot', 'skills', 'sprint-autopilot-on');

describe('lockdown: orchestrator mode moves workflow.md aside', () => {
  it('renames .claude/.../workflow.md → workflow.legacy.md.bak on start', () => {
    setExecutionMode('orchestrator');
    expect(existsSync(join(userSkillDir(), 'workflow.md'))).toBe(true);
    cli(['start']);
    expect(existsSync(join(userSkillDir(), 'workflow.md'))).toBe(false);
    expect(existsSync(join(userSkillDir(), 'workflow.legacy.md.bak'))).toBe(true);
  });

  it('renames _Sprintpilot/.../workflow.md → workflow.legacy.md.bak on start', () => {
    setExecutionMode('orchestrator');
    expect(existsSync(join(addonSkillDir(), 'workflow.md'))).toBe(true);
    cli(['start']);
    expect(existsSync(join(addonSkillDir(), 'workflow.md'))).toBe(false);
    expect(existsSync(join(addonSkillDir(), 'workflow.legacy.md.bak'))).toBe(true);
  });

  it('workflow.orchestrator.md is preserved (the live workflow)', () => {
    setExecutionMode('orchestrator');
    cli(['start']);
    expect(existsSync(join(userSkillDir(), 'workflow.orchestrator.md'))).toBe(true);
    expect(existsSync(join(addonSkillDir(), 'workflow.orchestrator.md'))).toBe(true);
  });

  it('is idempotent: running start twice does not error or re-clobber backup', () => {
    setExecutionMode('orchestrator');
    cli(['start']);
    const backupContent = readFileSync(join(userSkillDir(), 'workflow.legacy.md.bak'), 'utf-8');
    cli(['start']);
    // backup still there with same content
    expect(readFileSync(join(userSkillDir(), 'workflow.legacy.md.bak'), 'utf-8')).toBe(
      backupContent,
    );
    expect(existsSync(join(userSkillDir(), 'workflow.md'))).toBe(false);
  });

  it('logs the lockdown action to the ledger', () => {
    setExecutionMode('orchestrator');
    cli(['start']);
    const ledger = readFileSync(
      join(projectRoot, '_bmad-output', 'implementation-artifacts', 'ledger.jsonl'),
      'utf-8',
    );
    expect(ledger).toContain('"legacy_workflow":"moved_aside"');
  });
});

describe('lockdown: legacy mode restores workflow.md if a backup exists', () => {
  it('restores from .bak when execution_mode flipped back to legacy', () => {
    // First: orchestrator mode moves it aside.
    setExecutionMode('orchestrator');
    cli(['start']);
    expect(existsSync(join(userSkillDir(), 'workflow.md'))).toBe(false);

    // Then: user flips to legacy and starts again.
    setExecutionMode('legacy');
    cli(['start']);
    expect(existsSync(join(userSkillDir(), 'workflow.md'))).toBe(true);
    expect(existsSync(join(userSkillDir(), 'workflow.legacy.md.bak'))).toBe(false);
  });

  it('no-op when legacy mode is active and no backup exists', () => {
    setExecutionMode('legacy');
    expect(existsSync(join(userSkillDir(), 'workflow.md'))).toBe(true);
    cli(['start']);
    expect(existsSync(join(userSkillDir(), 'workflow.md'))).toBe(true);
    expect(existsSync(join(userSkillDir(), 'workflow.legacy.md.bak'))).toBe(false);
  });
});

describe('lockdown: SKILL.md instructs the LLM correctly', () => {
  it('SKILL.md explicitly documents that workflow.md is moved aside under orchestrator', () => {
    const skill = readFileSync(join(userSkillDir(), 'SKILL.md'), 'utf-8');
    expect(skill).toContain('workflow.legacy.md.bak');
    expect(skill).toContain('orchestrator');
    expect(skill).toContain('workflow.orchestrator.md');
  });
});
