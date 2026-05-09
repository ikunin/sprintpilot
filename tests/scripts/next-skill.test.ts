import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScript } from './helpers/run.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-next-skill-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setupNanoProject(dir: string) {
  // Minimal layout so resolve-profile.js sees the nano profile.
  const profilesDir = path.join(dir, '_Sprintpilot/modules/autopilot/profiles');
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(
    path.join(dir, '_Sprintpilot/modules/autopilot/config.yaml'),
    'autopilot:\n  complexity_profile: nano\n',
  );
  writeFileSync(path.join(profilesDir, '_base.yaml'), 'name: _base\n');
  writeFileSync(
    path.join(profilesDir, 'nano.yaml'),
    'name: nano\nautopilot:\n  implementation_flow: quick\n',
  );
  for (const p of ['small', 'medium', 'large']) {
    writeFileSync(
      path.join(profilesDir, `${p}.yaml`),
      `name: ${p}\nautopilot:\n  implementation_flow: full\n`,
    );
  }
  writeFileSync(
    path.join(profilesDir, 'legacy.yaml'),
    'name: legacy\nversion_pinned: 1.0.5\nautopilot:\n  implementation_flow: full\n',
  );
}

describe('next-skill (end-to-end with profile)', () => {
  it('reroutes bmad-dev-story → bmad-quick-dev under nano profile', () => {
    setupNanoProject(dir);
    const r = runScript('next-skill', ['--proposed', 'bmad-dev-story'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('bmad-quick-dev');
    expect(r.stderr).toMatch(/nano/);
  });

  it('passes bmad-help through unchanged under nano profile', () => {
    setupNanoProject(dir);
    const r = runScript('next-skill', ['--proposed', 'bmad-help'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('bmad-help');
    expect(r.stderr).toBe('');
  });

  it('--implementation-flow override skips profile resolution', () => {
    // No project setup at all — flow override means we don't need a profile.
    const r = runScript(
      'next-skill',
      ['--proposed', 'bmad-dev-story', '--implementation-flow', 'quick'],
      { cwd: dir },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('bmad-quick-dev');
  });

  it('falls back to full when no profile config exists', () => {
    // Empty project — resolve-profile errors → fall back to 'full' → no reroute.
    const r = runScript('next-skill', ['--proposed', 'bmad-dev-story'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('bmad-dev-story');
  });

  it('exits 1 when --proposed is missing', () => {
    const r = runScript('next-skill', [], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('--proposed');
  });
});
