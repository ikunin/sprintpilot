import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — CommonJS module
import bmadConfigMod from '../../lib/core/bmad-config.js';

const {
  readOutputFolder,
  verifyBmadInstalled,
  readBmadVersion,
  readAddonManifestVersion,
  readCompatBounds,
  checkBmadCompat,
} = bmadConfigMod as {
  readOutputFolder: (projectRoot: string) => Promise<string>;
  verifyBmadInstalled: (projectRoot: string) => Promise<Record<string, unknown> | null>;
  readBmadVersion: (projectRoot: string) => Promise<string | null>;
  readAddonManifestVersion: (manifestPath: string) => Promise<string | null>;
  readCompatBounds: (
    manifestPath: string,
  ) => Promise<{ floor: string | null; testedThrough: string | null }>;
  checkBmadCompat: (
    version: string | null,
    bounds?: { floor?: string | null; testedThrough?: string | null },
  ) => { level: 'ok' | 'below_floor' | 'above_tested'; message: string | null };
};

const BOUNDS = { floor: '6.2.1', testedThrough: '6.10.0' };

describe('bmad-config', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bmad-cfg-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it('defaults to _bmad-output when _bmad missing', async () => {
    expect(await readOutputFolder(dir)).toBe('_bmad-output');
  });

  it('reads output_folder from _bmad/bmm/config.yaml', async () => {
    mkdirSync(join(dir, '_bmad', 'bmm'), { recursive: true });
    writeFileSync(join(dir, '_bmad', 'bmm', 'config.yaml'), 'output_folder: custom/path\n', 'utf8');
    expect(await readOutputFolder(dir)).toBe('custom/path');
  });

  it('strips {project-root}/ prefix when present', async () => {
    mkdirSync(join(dir, '_bmad', 'bmm'), { recursive: true });
    writeFileSync(
      join(dir, '_bmad', 'bmm', 'config.yaml'),
      'output_folder: "{project-root}/out/dir"\n',
      'utf8',
    );
    expect(await readOutputFolder(dir)).toBe('out/dir');
  });

  it('prefers bmm over other modules', async () => {
    mkdirSync(join(dir, '_bmad', 'bmm'), { recursive: true });
    mkdirSync(join(dir, '_bmad', 'core'), { recursive: true });
    writeFileSync(join(dir, '_bmad', 'bmm', 'config.yaml'), 'output_folder: from-bmm\n', 'utf8');
    writeFileSync(join(dir, '_bmad', 'core', 'config.yaml'), 'output_folder: from-core\n', 'utf8');
    expect(await readOutputFolder(dir)).toBe('from-bmm');
  });

  it('falls back to other modules when bmm lacks output_folder', async () => {
    mkdirSync(join(dir, '_bmad', 'bmm'), { recursive: true });
    mkdirSync(join(dir, '_bmad', 'core'), { recursive: true });
    writeFileSync(join(dir, '_bmad', 'bmm', 'config.yaml'), 'project_name: x\n', 'utf8');
    writeFileSync(join(dir, '_bmad', 'core', 'config.yaml'), 'output_folder: from-core\n', 'utf8');
    expect(await readOutputFolder(dir)).toBe('from-core');
  });

  it('returns default when output_folder is blank/empty string', async () => {
    mkdirSync(join(dir, '_bmad', 'bmm'), { recursive: true });
    writeFileSync(join(dir, '_bmad', 'bmm', 'config.yaml'), 'output_folder: ""\n', 'utf8');
    expect(await readOutputFolder(dir)).toBe('_bmad-output');
  });

  it('reads output_folder from _bmad/config.toml (v6.4+ layout)', async () => {
    mkdirSync(join(dir, '_bmad'), { recursive: true });
    writeFileSync(
      join(dir, '_bmad', 'config.toml'),
      '[core]\nproject_name = "demo"\n\n[modules.bmm]\noutput_folder = "toml/out"\n',
      'utf8',
    );
    expect(await readOutputFolder(dir)).toBe('toml/out');
  });

  it('config.user.toml overrides config.toml', async () => {
    mkdirSync(join(dir, '_bmad'), { recursive: true });
    writeFileSync(join(dir, '_bmad', 'config.toml'), 'output_folder = "base/out"\n', 'utf8');
    writeFileSync(join(dir, '_bmad', 'config.user.toml'), 'output_folder = "user/out"\n', 'utf8');
    expect(await readOutputFolder(dir)).toBe('user/out');
  });

  it('prefers config.yaml over config.toml when both exist', async () => {
    mkdirSync(join(dir, '_bmad', 'bmm'), { recursive: true });
    writeFileSync(join(dir, '_bmad', 'bmm', 'config.yaml'), 'output_folder: yaml/wins\n', 'utf8');
    writeFileSync(join(dir, '_bmad', 'config.toml'), 'output_folder = "toml/loses"\n', 'utf8');
    expect(await readOutputFolder(dir)).toBe('yaml/wins');
  });

  it('strips quotes, {project-root}/ prefix, and trailing comment in TOML', async () => {
    mkdirSync(join(dir, '_bmad'), { recursive: true });
    writeFileSync(
      join(dir, '_bmad', 'config.toml'),
      'output_folder = "{project-root}/toml/dir"   # configured output\n',
      'utf8',
    );
    expect(await readOutputFolder(dir)).toBe('toml/dir');
  });

  it('verifyBmadInstalled returns null when _bmad/_config/manifest.yaml missing', async () => {
    expect(await verifyBmadInstalled(dir)).toBeNull();
  });

  it('verifyBmadInstalled returns parsed manifest when present', async () => {
    mkdirSync(join(dir, '_bmad', '_config'), { recursive: true });
    writeFileSync(
      join(dir, '_bmad', '_config', 'manifest.yaml'),
      'version: 6.3.0\nname: bmad\n',
      'utf8',
    );
    const m = await verifyBmadInstalled(dir);
    expect(m).not.toBeNull();
    expect((m as Record<string, unknown>).version).toBe('6.3.0');
  });

  it('readBmadVersion returns the version from the legacy flat manifest shape', async () => {
    mkdirSync(join(dir, '_bmad', '_config'), { recursive: true });
    writeFileSync(join(dir, '_bmad', '_config', 'manifest.yaml'), 'version: 6.2.2\n', 'utf8');
    expect(await readBmadVersion(dir)).toBe('6.2.2');
  });

  it('readBmadVersion returns the version from the nested v6 manifest shape', async () => {
    mkdirSync(join(dir, '_bmad', '_config'), { recursive: true });
    writeFileSync(
      join(dir, '_bmad', '_config', 'manifest.yaml'),
      'bmad:\n  version: "6.2.0"\n',
      'utf8',
    );
    expect(await readBmadVersion(dir)).toBe('6.2.0');
  });

  it('readBmadVersion returns the version from the v6.2.x installation-scoped manifest shape', async () => {
    // v6.2.x BMad installer writes this shape — both the project and
    // every module carry their own `version` field. The installer-level
    // version under `installation.version` is the canonical "BMad
    // Method version" we want to display. Pre-fix, neither code path
    // (nested `bmad.version`, flat `version`) matched, so the installer
    // showed "BMad Method version: unknown".
    mkdirSync(join(dir, '_bmad', '_config'), { recursive: true });
    writeFileSync(
      join(dir, '_bmad', '_config', 'manifest.yaml'),
      [
        'installation:',
        '  version: 6.2.2',
        '  installDate: 2026-03-28T00:06:49.079Z',
        'modules:',
        '  - name: core',
        '    version: 6.2.2',
        '  - name: bmm',
        '    version: 6.2.2',
        '  - name: tea',
        '    version: 1.7.2',
        '',
      ].join('\n'),
      'utf8',
    );
    expect(await readBmadVersion(dir)).toBe('6.2.2');
  });

  it('readBmadVersion prefers installation.version over a module entry sharing the version field', async () => {
    // The modules array carries per-module versions; we must NOT pick
    // up a module's version when installation.version is present.
    mkdirSync(join(dir, '_bmad', '_config'), { recursive: true });
    writeFileSync(
      join(dir, '_bmad', '_config', 'manifest.yaml'),
      [
        'installation:',
        '  version: 6.2.2',
        'modules:',
        '  - name: tea',
        '    version: 1.7.2',
        '',
      ].join('\n'),
      'utf8',
    );
    expect(await readBmadVersion(dir)).toBe('6.2.2');
  });

  it('readAddonManifestVersion parses addon.version', async () => {
    const p = join(dir, 'manifest.yaml');
    writeFileSync(p, 'addon:\n  name: x\n  version: 1.2.3\n', 'utf8');
    expect(await readAddonManifestVersion(p)).toBe('1.2.3');
  });

  it('readAddonManifestVersion returns null for missing file', async () => {
    expect(await readAddonManifestVersion(join(dir, 'nope.yaml'))).toBeNull();
  });

  // Regression: deterministic precedence across filesystems when multiple
  // non-priority module configs are present.
  it('falls back to module configs in alphabetical order (not readdir order)', async () => {
    // No bmm/core/bmb/cis — two non-priority modules.
    mkdirSync(join(dir, '_bmad', 'zeta'), { recursive: true });
    mkdirSync(join(dir, '_bmad', 'alpha'), { recursive: true });
    writeFileSync(
      join(dir, '_bmad', 'alpha', 'config.yaml'),
      'output_folder: from-alpha\n',
      'utf8',
    );
    writeFileSync(join(dir, '_bmad', 'zeta', 'config.yaml'), 'output_folder: from-zeta\n', 'utf8');
    expect(await readOutputFolder(dir)).toBe('from-alpha');
  });

  // Regression: malformed YAML must warn (not silently fall back to default).
  it('warns on malformed YAML and still falls back to default', async () => {
    const calls: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => {
      calls.push(String(msg));
    };
    try {
      mkdirSync(join(dir, '_bmad', 'bmm'), { recursive: true });
      // Invalid YAML — a tab + mismatched indent triggers parse failure in js-yaml.
      writeFileSync(join(dir, '_bmad', 'bmm', 'config.yaml'), 'key:\n\tvalue: oops\n :\n', 'utf8');
      const folder = await readOutputFolder(dir);
      expect(folder).toBe('_bmad-output');
    } finally {
      console.warn = origWarn;
    }
    expect(calls.some((m) => /failed to parse YAML/.test(m))).toBe(true);
  });

  // A6 — soft, advisory BMad version guard.
  describe('checkBmadCompat', () => {
    it('returns ok within [floor, testedThrough]', () => {
      for (const v of ['6.2.1', '6.8.0', '6.10.0']) {
        expect(checkBmadCompat(v, BOUNDS).level).toBe('ok');
      }
    });

    it('flags below_floor for versions under the floor', () => {
      const r = checkBmadCompat('6.2.0', BOUNDS);
      expect(r.level).toBe('below_floor');
      expect(r.message).toMatch(/below/i);
    });

    it('flags above_tested for versions past the ceiling', () => {
      const r = checkBmadCompat('6.11.0', BOUNDS);
      expect(r.level).toBe('above_tested');
      expect(r.message).toMatch(/newer/i);
    });

    it('never warns on unknown/unparseable version', () => {
      expect(checkBmadCompat('unknown', BOUNDS).level).toBe('ok');
      expect(checkBmadCompat(null, BOUNDS).level).toBe('ok');
      expect(checkBmadCompat('', BOUNDS).message).toBeNull();
    });

    it('treats missing bounds as no constraint', () => {
      expect(checkBmadCompat('1.0.0', {}).level).toBe('ok');
      expect(checkBmadCompat('99.0.0', {}).level).toBe('ok');
    });

    it('coerces a "v"-prefixed version', () => {
      expect(checkBmadCompat('v6.9.0', BOUNDS).level).toBe('ok');
    });
  });

  describe('readCompatBounds', () => {
    it('parses floor and tested-through from an addon manifest', async () => {
      const manifest = join(dir, 'manifest.yaml');
      writeFileSync(
        manifest,
        'addon:\n  bmad_compatibility: ">=6.2.1"\n  bmad_tested_through: "6.10.0"\n',
        'utf8',
      );
      expect(await readCompatBounds(manifest)).toEqual({ floor: '6.2.1', testedThrough: '6.10.0' });
    });

    it('returns null bounds when fields are absent', async () => {
      const manifest = join(dir, 'manifest.yaml');
      writeFileSync(manifest, 'addon:\n  name: sprintpilot\n', 'utf8');
      expect(await readCompatBounds(manifest)).toEqual({ floor: null, testedThrough: null });
    });
  });
});
