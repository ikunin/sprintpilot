import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — CommonJS module
import v1Detect from "../../lib/core/v1-detect.js";

const {
  V1_ADDON_DIR_NAME,
  V1_MANIFEST_NAME,
  V1_SKILL_NAMES,
  detectV1Installation,
} = v1Detect as {
  V1_ADDON_DIR_NAME: string;
  V1_MANIFEST_NAME: string;
  V1_SKILL_NAMES: string[];
  detectV1Installation: (root: string) => Promise<{
    v1Dir: string;
    detectedVia: 'manifest' | 'skills-no-manifest' | 'skills-unreadable-manifest' | 'skills-other-addon';
    manifestAddonName: string | null;
  } | null>;
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "v1-detect-"));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("detectV1Installation", () => {
  it("returns null when _bmad-addons/ does not exist", async () => {
    expect(await detectV1Installation(root)).toBeNull();
  });

  it("detects v1 via manifest.yaml with addon.name=bmad-ma-git", async () => {
    const dir = join(root, V1_ADDON_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.yaml"),
      `addon:\n  name: ${V1_MANIFEST_NAME}\n  version: 1.0.21\n`,
      "utf8",
    );
    const result = await detectV1Installation(root);
    expect(result).not.toBeNull();
    expect(result!.detectedVia).toBe("manifest");
    expect(result!.manifestAddonName).toBe(V1_MANIFEST_NAME);
  });

  it("returns null when manifest names something OTHER than bmad-ma-git and no v1 skill dirs", async () => {
    const dir = join(root, V1_ADDON_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.yaml"),
      `addon:\n  name: some-other-addon\n  version: 1.0.0\n`,
      "utf8",
    );
    expect(await detectV1Installation(root)).toBeNull();
  });

  it("flags 'skills-other-addon' when manifest names a different addon but v1 skill dirs exist (ambiguous)", async () => {
    const dir = join(root, V1_ADDON_DIR_NAME);
    const skillsDir = join(dir, "skills");
    mkdirSync(join(skillsDir, V1_SKILL_NAMES[0]), { recursive: true });
    writeFileSync(
      join(dir, "manifest.yaml"),
      `addon:\n  name: custom-addon\n  version: 0.1.0\n`,
      "utf8",
    );
    const result = await detectV1Installation(root);
    expect(result).not.toBeNull();
    expect(result!.detectedVia).toBe("skills-other-addon");
    expect(result!.manifestAddonName).toBe("custom-addon");
  });

  it("falls through to skill-dir heuristic when manifest is missing", async () => {
    const skillsDir = join(root, V1_ADDON_DIR_NAME, "skills");
    mkdirSync(join(skillsDir, V1_SKILL_NAMES[0]), { recursive: true });
    const result = await detectV1Installation(root);
    expect(result).not.toBeNull();
    expect(result!.detectedVia).toBe("skills-no-manifest");
  });

  it("falls through to skill-dir heuristic when manifest is malformed YAML", async () => {
    const dir = join(root, V1_ADDON_DIR_NAME);
    const skillsDir = join(dir, "skills");
    mkdirSync(join(skillsDir, V1_SKILL_NAMES[0]), { recursive: true });
    // Intentionally broken YAML
    writeFileSync(join(dir, "manifest.yaml"), "addon: [unclosed\n", "utf8");
    const result = await detectV1Installation(root);
    expect(result).not.toBeNull();
    expect(result!.detectedVia).toBe("skills-unreadable-manifest");
  });

  it("returns null when _bmad-addons/ has no v1 signature (manifest missing, no v1 skill dirs)", async () => {
    const skillsDir = join(root, V1_ADDON_DIR_NAME, "skills");
    mkdirSync(join(skillsDir, "some-unrelated-skill"), { recursive: true });
    expect(await detectV1Installation(root)).toBeNull();
  });
});
