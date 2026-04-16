import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempRepoWithRemote,
  gitIn,
  writeRaw,
  type TempRepo,
} from "./helpers/repo.js";
import { runScript } from "./helpers/run.js";

describe("health-check", () => {
  let repo: TempRepo;

  beforeEach(() => { repo = createTempRepoWithRemote(); });
  afterEach(() => { repo.cleanup(); });

  it("no worktrees dir returns empty summary", () => {
    const r = runScript("health-check", ["--worktrees-dir", "nonexistent"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("SUMMARY:0:0:0:0:0:0");
  });

  it("empty worktrees dir returns empty summary", () => {
    mkdirSync(join(repo.dir, ".worktrees"), { recursive: true });
    const r = runScript("health-check", ["--worktrees-dir", ".worktrees"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("SUMMARY:0:0:0:0:0:0");
  });

  it("clean worktree with done status classified as CLEAN_DONE", () => {
    gitIn(repo.dir, ["worktree", "add", ".worktrees/story-1", "-b", "story/story-1"]);
    writeRaw(repo.dir, "status.yaml", `  story-1:\n    status: done\n`);
    const r = runScript("health-check", [
      "--worktrees-dir", ".worktrees",
      "--status-file", "status.yaml",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("CLEAN_DONE:story-1");
    expect(r.stdout).toContain("SUMMARY:1:1:0:0:0:0");
  });

  it("worktree with uncommitted changes classified as DIRTY", () => {
    gitIn(repo.dir, ["worktree", "add", ".worktrees/story-2", "-b", "story/story-2"]);
    writeFileSync(join(repo.dir, ".worktrees", "story-2", "dirty.txt"), "dirty\n", "utf8");
    const r = runScript("health-check", ["--worktrees-dir", ".worktrees"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DIRTY:story-2");
  });

  it("worktree with commits ahead classified as COMMITTED", () => {
    gitIn(repo.dir, ["worktree", "add", ".worktrees/story-3", "-b", "story/story-3"]);
    const wtDir = join(repo.dir, ".worktrees", "story-3");
    writeFileSync(join(wtDir, "work.txt"), "new work\n", "utf8");
    gitIn(wtDir, ["add", "work.txt"]);
    gitIn(wtDir, ["commit", "-m", "story work", "--quiet"]);
    const r = runScript("health-check", ["--worktrees-dir", ".worktrees"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("COMMITTED:story-3");
  });

  it("worktree with no commits ahead classified as STALE", () => {
    gitIn(repo.dir, ["worktree", "add", ".worktrees/story-4", "-b", "story/story-4"]);
    const r = runScript("health-check", ["--worktrees-dir", ".worktrees"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("STALE:story-4");
  });

  it("non-worktree directory classified as DIRTY (inherits parent git context)", () => {
    mkdirSync(join(repo.dir, ".worktrees", "orphan-dir"), { recursive: true });
    writeFileSync(join(repo.dir, ".worktrees", "orphan-dir", "file.txt"), "not a git repo\n", "utf8");
    const r = runScript("health-check", ["--worktrees-dir", ".worktrees"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DIRTY:orphan-dir");
  });

  it("detached HEAD classified as ORPHAN", () => {
    gitIn(repo.dir, ["worktree", "add", ".worktrees/detached", "-b", "temp-branch"]);
    const wtDir = join(repo.dir, ".worktrees", "detached");
    const sha = gitIn(wtDir, ["rev-parse", "HEAD"]).trim();
    gitIn(wtDir, ["checkout", "--detach", sha]);
    const r = runScript("health-check", ["--worktrees-dir", ".worktrees"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ORPHAN:detached");
  });

  it("mixed worktree statuses produce correct summary", () => {
    gitIn(repo.dir, ["worktree", "add", ".worktrees/stale-one", "-b", "story/stale-one"]);
    gitIn(repo.dir, ["worktree", "add", ".worktrees/dirty-one", "-b", "story/dirty-one"]);
    writeFileSync(join(repo.dir, ".worktrees", "dirty-one", "x.txt"), "dirty\n", "utf8");
    const r = runScript("health-check", ["--worktrees-dir", ".worktrees"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("STALE:stale-one");
    expect(r.stdout).toContain("DIRTY:dirty-one");
    expect(r.stdout).toContain("SUMMARY:2:0:0:1:1:0");
  });

  it("custom base branch works", () => {
    gitIn(repo.dir, ["checkout", "-b", "develop"]);
    gitIn(repo.dir, ["push", "-u", "origin", "develop", "--quiet"]);
    gitIn(repo.dir, ["worktree", "add", ".worktrees/story-x", "-b", "story/story-x"]);
    const r = runScript("health-check", [
      "--worktrees-dir", ".worktrees",
      "--base-branch", "develop",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("STALE:story-x");
  });

  it("help flag shows usage", () => {
    const r = runScript("health-check", ["--help"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });
});
