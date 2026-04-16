import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempRepo,
  commitFile,
  modifyFile,
  createUntracked,
  writeRaw,
  gitIn,
  type TempRepo,
} from "./helpers/repo.js";
import { runScript } from "./helpers/run.js";

const SHA_RE = /^[a-f0-9]{40}$/m;

describe("stage-and-commit", () => {
  let repo: TempRepo;

  beforeEach(() => { repo = createTempRepo(); });
  afterEach(() => { repo.cleanup(); });

  it("commits modified tracked file and outputs SHA", () => {
    writeRaw(repo.dir, ".gitignore", ".autopilot.lock\n");
    gitIn(repo.dir, ["add", ".gitignore"]);
    gitIn(repo.dir, ["commit", "-m", "add gitignore", "--quiet"]);
    commitFile(repo.dir, "hello.txt", "original");
    modifyFile(repo.dir, "hello.txt", "updated");

    const r = runScript("stage-and-commit", ["--message", "update hello"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^[a-f0-9]{40}$/);
    expect(gitIn(repo.dir, ["log", "--oneline", "-1"])).toContain("update hello");
  });

  it("commits untracked file", () => {
    createUntracked(repo.dir, "newfile.txt");
    const r = runScript("stage-and-commit", ["--message", "add newfile"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(SHA_RE.test(r.stdout)).toBe(true);
  });

  it("nothing to commit exits 1", () => {
    const r = runScript("stage-and-commit", ["--message", "empty"], { cwd: repo.dir });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("Nothing to commit");
  });

  it("missing message exits 2", () => {
    createUntracked(repo.dir, "file.txt");
    const r = runScript("stage-and-commit", [], { cwd: repo.dir });
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toContain("--message required");
  });

  it("dry-run lists files without committing", () => {
    commitFile(repo.dir, "hello.txt", "original");
    modifyFile(repo.dir, "hello.txt", "changed");
    createUntracked(repo.dir, "new.txt");

    const r = runScript("stage-and-commit", ["--message", "test", "--dry-run"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
    expect(r.stdout).toContain("hello.txt");
    expect(r.stdout).toContain("new.txt");
    const count = gitIn(repo.dir, ["log", "--oneline"]).trim().split("\n").length;
    expect(count).toBe(2); // initial + commit_file
  });

  it("secrets detection warns on stderr", () => {
    commitFile(repo.dir, "config.js", "const x = 1");
    modifyFile(repo.dir, "config.js", "const API_KEY = 'sk-12345'");

    const r = runScript("stage-and-commit", ["--message", "add config"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("WARN: possible secret");
  });

  it("secrets allowlist skips matching files", () => {
    commitFile(repo.dir, "config.js", "const x = 1");
    modifyFile(repo.dir, "config.js", "const API_KEY = 'sk-12345'");
    writeRaw(repo.dir, "allowlist.txt", "config.js\n");

    const r = runScript("stage-and-commit", [
      "--message", "add config",
      "--allowlist", "allowlist.txt",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/WARN: possible secret in config\.js/);
  });

  it("large file detection warns", () => {
    commitFile(repo.dir, "small.txt", "small");
    writeFileSync(join(repo.dir, "large.bin"), Buffer.alloc(1024 * 1024 + 1));
    const r = runScript("stage-and-commit", ["--message", "add large"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("large file");
  });

  it("custom max-size-mb is respected", () => {
    writeFileSync(join(repo.dir, "medium.bin"), Buffer.alloc(102400));
    const r = runScript("stage-and-commit", [
      "--message", "add medium",
      "--max-size-mb", "0",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
  });

  it("gitignore missing autopilot.lock warns", () => {
    createUntracked(repo.dir, "file.txt");
    const r = runScript("stage-and-commit", ["--message", "test"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("WARN:");
  });

  it("gitignore with autopilot.lock does not warn about it", () => {
    writeRaw(repo.dir, ".gitignore", ".autopilot.lock\n");
    gitIn(repo.dir, ["add", ".gitignore"]);
    gitIn(repo.dir, ["commit", "-m", "add gitignore", "--quiet"]);
    createUntracked(repo.dir, "file.txt");

    const r = runScript("stage-and-commit", ["--message", "test"], { cwd: repo.dir });
    expect(r.stderr).not.toContain(".autopilot.lock");
  });

  it("file-list cross-reference warns on unexpected files", () => {
    commitFile(repo.dir, "expected.txt", "content");
    modifyFile(repo.dir, "expected.txt", "updated");
    createUntracked(repo.dir, "surprise.txt");
    writeRaw(repo.dir, "filelist.md", "- expected.txt\n");

    const r = runScript("stage-and-commit", [
      "--message", "test",
      "--file-list", "filelist.md",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("unexpected file");
  });

  it("handles files with spaces in names", () => {
    createUntracked(repo.dir, "my file.txt", "content");
    const r = runScript("stage-and-commit", ["--message", "file with spaces"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(SHA_RE.test(r.stdout)).toBe(true);
  });

  it("help flag shows usage", () => {
    const r = runScript("stage-and-commit", ["--help"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  // Regression: symlinks must be skipped so we don't read (and potentially
  // warn about) files outside the repo.
  it("symlinks are skipped (not scanned for secrets)", () => {
    const targetOutside = join(repo.dir, "target-file.txt");
    writeFileSync(targetOutside, "API_KEY=sk-outside\n", "utf8");
    // Commit target so it's no longer untracked noise; then change it so it's in diff.
    gitIn(repo.dir, ["add", "target-file.txt"]);
    gitIn(repo.dir, ["commit", "-m", "add target", "--quiet"]);
    writeFileSync(targetOutside, "API_KEY=sk-modified\n", "utf8");
    // Create symlink pointing to it — file-ops helper not available in test, use fs.
    const { symlinkSync } = require("node:fs");
    symlinkSync("target-file.txt", join(repo.dir, "link.txt"));

    const r = runScript("stage-and-commit", ["--message", "test"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    // Target file (not symlink) will be scanned and warn; the symlink
    // itself must NOT produce an additional warning.
    const linkWarnings = (r.stderr.match(/link\.txt/g) || []).length;
    expect(linkWarnings).toBe(0);
  });

  // Regression: files larger than MAX_SCAN_BYTES (2 MB) must skip the
  // secret scan entirely (with a "scan skipped" warning instead of OOM).
  it("files larger than 2 MB skip secret scan", () => {
    // Build a 2.5 MB file whose content would otherwise match the regex.
    const chunk = "API_KEY=sk-abc123xyz456abc123xyz456abc123\n"; // 42 bytes
    const repetitions = Math.ceil((2.5 * 1024 * 1024) / chunk.length);
    writeFileSync(join(repo.dir, "big.log"), chunk.repeat(repetitions));
    gitIn(repo.dir, ["add", "big.log"]);
    gitIn(repo.dir, ["commit", "-m", "add big", "--quiet"]);
    writeFileSync(join(repo.dir, "big.log"), chunk.repeat(repetitions + 1));

    const r = runScript("stage-and-commit", [
      "--message", "update big",
      "--max-size-mb", "100",
    ], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("secret scan skipped");
    expect(r.stderr).not.toMatch(/possible secret in big\.log/);
  });
});
