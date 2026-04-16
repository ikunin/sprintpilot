import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — CommonJS module
import bmadConfigMod from "../../lib/core/bmad-config.js";

const {
  readOutputFolder,
  verifyBmadInstalled,
  readBmadVersion,
  readAddonManifestVersion,
} = bmadConfigMod as {
  readOutputFolder: (projectRoot: string) => Promise<string>;
  verifyBmadInstalled: (projectRoot: string) => Promise<Record<string, unknown> | null>;
  readBmadVersion: (projectRoot: string) => Promise<string | null>;
  readAddonManifestVersion: (manifestPath: string) => Promise<string | null>;
};

describe("bmad-config", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bmad-cfg-")); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it("defaults to _bmad-output when _bmad missing", async () => {
    expect(await readOutputFolder(dir)).toBe("_bmad-output");
  });

  it("reads output_folder from _bmad/bmm/config.yaml", async () => {
    mkdirSync(join(dir, "_bmad", "bmm"), { recursive: true });
    writeFileSync(join(dir, "_bmad", "bmm", "config.yaml"), "output_folder: custom/path\n", "utf8");
    expect(await readOutputFolder(dir)).toBe("custom/path");
  });

  it("strips {project-root}/ prefix when present", async () => {
    mkdirSync(join(dir, "_bmad", "bmm"), { recursive: true });
    writeFileSync(join(dir, "_bmad", "bmm", "config.yaml"), 'output_folder: "{project-root}/out/dir"\n', "utf8");
    expect(await readOutputFolder(dir)).toBe("out/dir");
  });

  it("prefers bmm over other modules", async () => {
    mkdirSync(join(dir, "_bmad", "bmm"), { recursive: true });
    mkdirSync(join(dir, "_bmad", "core"), { recursive: true });
    writeFileSync(join(dir, "_bmad", "bmm", "config.yaml"), "output_folder: from-bmm\n", "utf8");
    writeFileSync(join(dir, "_bmad", "core", "config.yaml"), "output_folder: from-core\n", "utf8");
    expect(await readOutputFolder(dir)).toBe("from-bmm");
  });

  it("falls back to other modules when bmm lacks output_folder", async () => {
    mkdirSync(join(dir, "_bmad", "bmm"), { recursive: true });
    mkdirSync(join(dir, "_bmad", "core"), { recursive: true });
    writeFileSync(join(dir, "_bmad", "bmm", "config.yaml"), "project_name: x\n", "utf8");
    writeFileSync(join(dir, "_bmad", "core", "config.yaml"), "output_folder: from-core\n", "utf8");
    expect(await readOutputFolder(dir)).toBe("from-core");
  });

  it("returns default when output_folder is blank/empty string", async () => {
    mkdirSync(join(dir, "_bmad", "bmm"), { recursive: true });
    writeFileSync(join(dir, "_bmad", "bmm", "config.yaml"), 'output_folder: ""\n', "utf8");
    expect(await readOutputFolder(dir)).toBe("_bmad-output");
  });

  it("verifyBmadInstalled returns null when _bmad/_config/manifest.yaml missing", async () => {
    expect(await verifyBmadInstalled(dir)).toBeNull();
  });

  it("verifyBmadInstalled returns parsed manifest when present", async () => {
    mkdirSync(join(dir, "_bmad", "_config"), { recursive: true });
    writeFileSync(join(dir, "_bmad", "_config", "manifest.yaml"), "version: 6.3.0\nname: bmad\n", "utf8");
    const m = await verifyBmadInstalled(dir);
    expect(m).not.toBeNull();
    expect((m as Record<string, unknown>).version).toBe("6.3.0");
  });

  it("readBmadVersion returns the version string", async () => {
    mkdirSync(join(dir, "_bmad", "_config"), { recursive: true });
    writeFileSync(join(dir, "_bmad", "_config", "manifest.yaml"), "version: 6.2.2\n", "utf8");
    expect(await readBmadVersion(dir)).toBe("6.2.2");
  });

  it("readAddonManifestVersion parses addon.version", async () => {
    const p = join(dir, "manifest.yaml");
    writeFileSync(p, "addon:\n  name: x\n  version: 1.2.3\n", "utf8");
    expect(await readAddonManifestVersion(p)).toBe("1.2.3");
  });

  it("readAddonManifestVersion returns null for missing file", async () => {
    expect(await readAddonManifestVersion(join(dir, "nope.yaml"))).toBeNull();
  });

  // Regression: deterministic precedence across filesystems when multiple
  // non-priority module configs are present.
  it("falls back to module configs in alphabetical order (not readdir order)", async () => {
    // No bmm/core/bmb/cis — two non-priority modules.
    mkdirSync(join(dir, "_bmad", "zeta"), { recursive: true });
    mkdirSync(join(dir, "_bmad", "alpha"), { recursive: true });
    writeFileSync(join(dir, "_bmad", "alpha", "config.yaml"), "output_folder: from-alpha\n", "utf8");
    writeFileSync(join(dir, "_bmad", "zeta", "config.yaml"), "output_folder: from-zeta\n", "utf8");
    expect(await readOutputFolder(dir)).toBe("from-alpha");
  });

  // Regression: malformed YAML must warn (not silently fall back to default).
  it("warns on malformed YAML and still falls back to default", async () => {
    const calls: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { calls.push(String(msg)); };
    try {
      mkdirSync(join(dir, "_bmad", "bmm"), { recursive: true });
      // Invalid YAML — a tab + mismatched indent triggers parse failure in js-yaml.
      writeFileSync(join(dir, "_bmad", "bmm", "config.yaml"), "key:\n\tvalue: oops\n :\n", "utf8");
      const folder = await readOutputFolder(dir);
      expect(folder).toBe("_bmad-output");
    } finally {
      console.warn = origWarn;
    }
    expect(calls.some((m) => /failed to parse YAML/.test(m))).toBe(true);
  });
});
