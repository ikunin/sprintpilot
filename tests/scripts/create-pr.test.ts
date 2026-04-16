import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempRepo, gitIn, type TempRepo } from "./helpers/repo.js";
import { runScript } from "./helpers/run.js";

describe("create-pr", () => {
  let repo: TempRepo;

  beforeEach(() => { repo = createTempRepo(); });
  afterEach(() => { repo.cleanup(); });

  it("git_only platform returns SKIPPED and exits 2", () => {
    gitIn(repo.dir, ["remote", "add", "origin", "https://example.com/repo.git"]);
    const r = runScript("create-pr", [
      "--platform", "git_only",
      "--branch", "story/1-1",
      "--title", "Test PR",
    ], { cwd: repo.dir });
    expect(r.status).toBe(2);
    expect(r.stdout.split("\n")[0]).toBe("SKIPPED");
  });

  it("missing required flags exits 1", () => {
    const r = runScript("create-pr", [], { cwd: repo.dir });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("--platform, --branch, and --title are required");
  });

  it("missing branch flag exits 1", () => {
    const r = runScript("create-pr", ["--platform", "github", "--title", "Test"], { cwd: repo.dir });
    expect(r.status).toBe(1);
  });

  it("missing title flag exits 1", () => {
    const r = runScript("create-pr", ["--platform", "github", "--branch", "story/1-1"], { cwd: repo.dir });
    expect(r.status).toBe(1);
  });

  it("no remote configured returns SKIPPED and exits 2", () => {
    const r = runScript("create-pr", [
      "--platform", "github",
      "--branch", "story/1-1",
      "--title", "Test PR",
    ], { cwd: repo.dir });
    expect(r.status).toBe(2);
    expect(r.stdout.split("\n")[0]).toBe("SKIPPED");
  });

  it("dry-run prints info without creating PR", () => {
    gitIn(repo.dir, ["remote", "add", "origin", "https://github.com/user/repo.git"]);
    const r = runScript("create-pr", [
      "--platform", "github",
      "--branch", "story/1-1",
      "--base", "main",
      "--title", "Test PR",
      "--body", "Test body",
      "--dry-run",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
    expect(r.stdout).toContain("story/1-1");
    expect(r.stdout).toContain("Test PR");
  });

  it("unknown platform exits 1", () => {
    gitIn(repo.dir, ["remote", "add", "origin", "https://example.com/repo.git"]);
    const r = runScript("create-pr", [
      "--platform", "unknown_platform",
      "--branch", "story/1-1",
      "--title", "Test",
    ], { cwd: repo.dir });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("unknown platform");
  });

  it("help flag shows usage", () => {
    const r = runScript("create-pr", ["--help"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });
});
