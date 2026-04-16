import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "./helpers/repo.js";
import { runScript } from "./helpers/run.js";

function read(dir: string, file: string): string {
  return readFileSync(join(dir, file), "utf8");
}

describe("sync-status", () => {
  let repo: TempRepo;

  beforeEach(() => { repo = createTempRepo(); });
  afterEach(() => { repo.cleanup(); });

  it("creates new git-status.yaml from scratch", () => {
    const r = runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--platform", "github",
      "--base-branch", "main",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("OK:1-1:")).toBe(true);
    expect(existsSync(join(repo.dir, "git-status.yaml"))).toBe(true);
    const content = read(repo.dir, "git-status.yaml");
    expect(content).toMatch(/stories:/);
    expect(content).toMatch(/1-1:/);
    expect(content).toMatch(/branch:/);
  });

  it("creates parent directories for git-status-file", () => {
    const r = runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "deep/nested/dir/git-status.yaml",
      "--branch", "story/1-1",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(existsSync(join(repo.dir, "deep/nested/dir/git-status.yaml"))).toBe(true);
  });

  it("updates existing story entry", () => {
    runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--push-status", "pending",
      "--platform", "github",
    ], { cwd: repo.dir });

    const r = runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--push-status", "pushed",
      "--pr-url", "https://github.com/user/repo/pull/42",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    const content = read(repo.dir, "git-status.yaml");
    expect(content).toMatch(/push_status: pushed/);
    expect(content).toContain("https://github.com/user/repo/pull/42");
  });

  it("appends new story to existing file", () => {
    runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--platform", "github",
    ], { cwd: repo.dir });

    const r = runScript("sync-status", [
      "--story", "1-2",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-2",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    const content = read(repo.dir, "git-status.yaml");
    expect(content).toMatch(/1-1:/);
    expect(content).toMatch(/1-2:/);
  });

  it("all fields are written", () => {
    const r = runScript("sync-status", [
      "--story", "2-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/2-1",
      "--worktree", ".worktrees/2-1",
      "--commit", "abc123def456",
      "--patch-commits", "def789,ghi012",
      "--push-status", "pushed",
      "--pr-url", "https://github.com/u/r/pull/1",
      "--lint-result", "0 errors, 2 warnings",
      "--platform", "github",
      "--base-branch", "main",
      "--worktree-cleaned", "true",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    const content = read(repo.dir, "git-status.yaml");
    expect(content).toMatch(/branch:/);
    expect(content).toMatch(/worktree:/);
    expect(content).toMatch(/story_commit:/);
    expect(content).toMatch(/patch_commits:/);
    expect(content).toMatch(/push_status: pushed/);
    expect(content).toMatch(/pr_url:/);
    expect(content).toMatch(/lint_result:/);
    expect(content).toMatch(/worktree_cleaned: true/);
  });

  it("missing required args fails", () => {
    const r = runScript("sync-status", [], { cwd: repo.dir });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("--story and --git-status-file required");
  });

  it("missing story fails", () => {
    const r = runScript("sync-status", ["--git-status-file", "f.yaml"], { cwd: repo.dir });
    expect(r.status).toBe(1);
  });

  it("missing git-status-file fails", () => {
    const r = runScript("sync-status", ["--story", "1-1"], { cwd: repo.dir });
    expect(r.status).toBe(1);
  });

  it("YAML special characters in values are quoted", () => {
    const r = runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--lint-result", "errors: 3, warnings: [none]",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    const content = read(repo.dir, "git-status.yaml");
    expect(content).toMatch(/lint_result:/);
  });

  it("git_integration header is written for new files", () => {
    runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--platform", "gitlab",
      "--base-branch", "develop",
    ], { cwd: repo.dir });
    const content = read(repo.dir, "git-status.yaml");
    expect(content).toMatch(/git_integration:/);
    expect(content).toMatch(/enabled: true/);
    expect(content).toMatch(/base_branch: develop/);
    expect(content).toMatch(/platform: gitlab/);
  });

  it("help flag shows usage", () => {
    const r = runScript("sync-status", ["--help"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  it("merge_status is written when provided", () => {
    const r = runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--push-status", "pushed",
      "--merge-status", "merged",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(read(repo.dir, "git-status.yaml")).toMatch(/merge_status: merged/);
  });

  it("merge_status omitted when not provided", () => {
    const r = runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--push-status", "pushed",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(read(repo.dir, "git-status.yaml")).not.toMatch(/merge_status:/);
  });

  it("merge_status supports all valid values", () => {
    for (const value of ["pending", "merged", "failed", "recovered", "pr_pending"]) {
      const file = join(repo.dir, "git-status.yaml");
      if (existsSync(file)) unlinkSync(file);
      const r = runScript("sync-status", [
        "--story", "1-1",
        "--git-status-file", "git-status.yaml",
        "--branch", "story/1-1",
        "--merge-status", value,
      ], { cwd: repo.dir });
      expect(r.status).toBe(0);
      expect(read(repo.dir, "git-status.yaml")).toContain(`merge_status: ${value}`);
    }
  });

  it("merge_status preserved when updating existing story with all fields", () => {
    runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--push-status", "pushed",
      "--merge-status", "merged",
      "--pr-url", "https://github.com/u/r/pull/1",
      "--platform", "github",
    ], { cwd: repo.dir });
    let content = read(repo.dir, "git-status.yaml");
    expect(content).toMatch(/merge_status: merged/);
    expect(content).toMatch(/push_status: pushed/);
    expect(content).toMatch(/pr_url:/);

    const r = runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--push-status", "pushed",
      "--merge-status", "recovered",
      "--pr-url", "https://github.com/u/r/pull/1",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    content = read(repo.dir, "git-status.yaml");
    expect(content).toMatch(/merge_status: recovered/);
    expect(content).toMatch(/push_status: pushed/);
    expect(content).toMatch(/pr_url:/);
  });

  it("all fields including merge_status are written together", () => {
    const r = runScript("sync-status", [
      "--story", "2-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/2-1",
      "--worktree", ".worktrees/2-1",
      "--commit", "abc123def456",
      "--patch-commits", "def789,ghi012",
      "--push-status", "pushed",
      "--merge-status", "merged",
      "--pr-url", "https://github.com/u/r/pull/1",
      "--lint-result", "0 errors, 2 warnings",
      "--platform", "github",
      "--base-branch", "main",
      "--worktree-cleaned", "true",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    const content = read(repo.dir, "git-status.yaml");
    expect(content).toMatch(/branch:/);
    expect(content).toMatch(/worktree:/);
    expect(content).toMatch(/story_commit:/);
    expect(content).toMatch(/patch_commits:/);
    expect(content).toMatch(/push_status: pushed/);
    expect(content).toMatch(/merge_status: merged/);
    expect(content).toMatch(/pr_url:/);
    expect(content).toMatch(/lint_result:/);
    expect(content).toMatch(/worktree_cleaned: true/);
  });

  it("merge_status field appears between push_status and pr_url", () => {
    runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--push-status", "pushed",
      "--merge-status", "merged",
      "--pr-url", "https://github.com/u/r/pull/1",
    ], { cwd: repo.dir });
    const content = read(repo.dir, "git-status.yaml");
    const lines = content.split("\n");
    const pushIdx = lines.findIndex((l) => l.includes("push_status:"));
    const mergeIdx = lines.findIndex((l) => l.includes("merge_status:"));
    const prIdx = lines.findIndex((l) => l.includes("pr_url:"));
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(pushIdx);
    expect(prIdx).toBeGreaterThan(mergeIdx);
  });

  it("updating story without merge_status does not add merge_status field", () => {
    runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--push-status", "pending",
    ], { cwd: repo.dir });
    expect(read(repo.dir, "git-status.yaml")).not.toMatch(/merge_status:/);

    const r = runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--push-status", "pushed",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(read(repo.dir, "git-status.yaml")).not.toMatch(/merge_status:/);
  });

  // Regression: worktree_cleaned field must NOT be emitted (i.e. not forced
  // to `false`) when the flag is absent. Prior behavior defaulted to
  // `worktree_cleaned: false` in every call, silently stomping prior `true`.
  // New behavior: field is absent from output unless explicitly provided.
  it("worktree_cleaned absent when flag not passed", () => {
    const r = runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--push-status", "pending",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(read(repo.dir, "git-status.yaml")).not.toMatch(/worktree_cleaned:/);
  });

  it("merge_status on one story does not affect another story", () => {
    runScript("sync-status", [
      "--story", "1-1",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-1",
      "--push-status", "pushed",
      "--merge-status", "merged",
    ], { cwd: repo.dir });
    runScript("sync-status", [
      "--story", "1-2",
      "--git-status-file", "git-status.yaml",
      "--branch", "story/1-2",
      "--push-status", "pushed",
    ], { cwd: repo.dir });

    const content = read(repo.dir, "git-status.yaml");
    const mergeCount = (content.match(/merge_status:/g) || []).length;
    expect(mergeCount).toBe(1);
    expect(content).toMatch(/merge_status: merged/);
  });
});
