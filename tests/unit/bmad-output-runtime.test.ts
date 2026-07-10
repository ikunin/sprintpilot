import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import bmadOutputMod from '../../_Sprintpilot/lib/runtime/bmad-output.js';

const { readOutputFolder, implArtifactsDir } = bmadOutputMod as {
  readOutputFolder: (projectRoot: string) => string | null;
  implArtifactsDir: (projectRoot: string) => string;
};

describe('runtime bmad-output', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bmad-out-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it('returns null when no config is present', () => {
    expect(readOutputFolder(dir)).toBeNull();
    // implArtifactsDir falls back to the _bmad-output default.
    expect(implArtifactsDir(dir)).toBe(join(dir, '_bmad-output', 'implementation-artifacts'));
  });

  it('reads output_folder from _bmad/bmm/config.yaml (v6.2.x)', () => {
    mkdirSync(join(dir, '_bmad', 'bmm'), { recursive: true });
    writeFileSync(join(dir, '_bmad', 'bmm', 'config.yaml'), 'output_folder: custom-out\n', 'utf8');
    expect(readOutputFolder(dir)).toBe('custom-out');
    expect(implArtifactsDir(dir)).toBe(join(dir, 'custom-out', 'implementation-artifacts'));
  });

  it('reads output_folder from _bmad/config.toml (v6.4+) when no yaml', () => {
    mkdirSync(join(dir, '_bmad'), { recursive: true });
    writeFileSync(
      join(dir, '_bmad', 'config.toml'),
      '[core]\nproject_name = "demo"\n\n[modules.bmm]\noutput_folder = "toml/out"\n',
      'utf8',
    );
    expect(readOutputFolder(dir)).toBe('toml/out');
  });

  it('config.user.toml overrides config.toml', () => {
    mkdirSync(join(dir, '_bmad'), { recursive: true });
    writeFileSync(join(dir, '_bmad', 'config.toml'), 'output_folder = "base/out"\n', 'utf8');
    writeFileSync(join(dir, '_bmad', 'config.user.toml'), 'output_folder = "user/out"\n', 'utf8');
    expect(readOutputFolder(dir)).toBe('user/out');
  });

  it('prefers config.yaml over config.toml when both exist', () => {
    mkdirSync(join(dir, '_bmad', 'bmm'), { recursive: true });
    writeFileSync(join(dir, '_bmad', 'bmm', 'config.yaml'), 'output_folder: yaml-wins\n', 'utf8');
    writeFileSync(join(dir, '_bmad', 'config.toml'), 'output_folder = "toml-loses"\n', 'utf8');
    expect(readOutputFolder(dir)).toBe('yaml-wins');
  });

  it('strips quotes, {project-root}/ prefix, and trailing comment in TOML', () => {
    mkdirSync(join(dir, '_bmad'), { recursive: true });
    writeFileSync(
      join(dir, '_bmad', 'config.toml'),
      'output_folder = "{project-root}/toml/dir"   # configured\n',
      'utf8',
    );
    expect(readOutputFolder(dir)).toBe('toml/dir');
  });
});
