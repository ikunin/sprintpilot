import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCli } from "./helpers/run.js";

function which(cmd: string): string | null {
  try { return execFileSync("which", [cmd], { encoding: "utf8" }).trim(); } catch { return null; }
}

function makeNodeOnlyPath(): { path: string; cleanup: () => void } {
  const nodeReal = which("node");
  if (!nodeReal) return { path: "/usr/bin:/bin", cleanup: () => {} };
  const binDir = mkdtempSync(join(tmpdir(), "bmad-nodeonly-"));
  symlinkSync(nodeReal, join(binDir, "node"));
  return {
    path: `${binDir}:/usr/bin:/bin`,
    cleanup: () => { try { rmSync(binDir, { recursive: true, force: true }); } catch { /* */ } },
  };
}

describe("check-update + --version", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bmad-cu-"));
    mkdirSync(join(dir, "_bmad-addons"), { recursive: true });
    writeFileSync(
      join(dir, "_bmad-addons", "manifest.yaml"),
      "addon:\n  name: bmad-ma-git\n  version: 1.0.10\n  description: test manifest\n",
      "utf8",
    );
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("check-update shows installed version from project manifest", () => {
    const r = runCli(["check-update"], { cwd: dir, env: { BMAD_PROJECT_ROOT: dir } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Installed: 1.0.10");
  });

  it("check-update reaches npm registry", () => {
    if (!which("npm")) return;
    const r = runCli(["check-update"], { cwd: dir, env: { BMAD_PROJECT_ROOT: dir } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Latest:");
    expect(r.stdout).not.toContain("unknown");
  });

  it("check-update detects newer version available", () => {
    if (!which("npm")) return;
    const r = runCli(["check-update"], { cwd: dir, env: { BMAD_PROJECT_ROOT: dir } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Update available");
    expect(r.stdout).toContain("npx bmad-autopilot-addon@latest");
  });

  it("check-update shows up-to-date when versions match", () => {
    if (!which("npm")) return;
    let latest = "";
    try {
      latest = execFileSync("npm", ["view", "bmad-autopilot-addon@latest", "version"], { encoding: "utf8" }).trim();
    } catch { return; }
    if (!latest) return;
    writeFileSync(
      join(dir, "_bmad-addons", "manifest.yaml"),
      `addon:\n  version: ${latest}\n`,
      "utf8",
    );
    const r = runCli(["check-update"], { cwd: dir, env: { BMAD_PROJECT_ROOT: dir } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Up to date");
  });

  it("check-update handles missing npm gracefully", () => {
    const { path, cleanup } = makeNodeOnlyPath();
    try {
      const r = runCli(["check-update"], {
        cwd: dir,
        env: { BMAD_PROJECT_ROOT: dir, PATH: path },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Installed: 1.0.10");
      expect(r.stdout).toContain("unknown");
    } finally {
      cleanup();
    }
  });

  it("check-update falls back to package manifest when no project manifest", () => {
    rmSync(join(dir, "_bmad-addons"), { recursive: true, force: true });
    const r = runCli(["check-update"], { cwd: dir, env: { BMAD_PROJECT_ROOT: dir } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No project installation found");
    expect(r.stdout).toContain("Installed:");
  });

  it("--version reads from project manifest", () => {
    const r = runCli(["--version"], { cwd: dir, env: { BMAD_PROJECT_ROOT: dir } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("1.0.10");
  });

  it("--version falls back to package manifest when no project", () => {
    rmSync(join(dir, "_bmad-addons"), { recursive: true, force: true });
    const r = runCli(["--version"], { cwd: dir, env: { BMAD_PROJECT_ROOT: dir } });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it("help text includes check-update command", () => {
    const r = runCli(["help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("check-update");
    expect(r.stdout).toContain("Check if a newer version is available");
  });
});
