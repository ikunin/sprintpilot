import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createTempRepo, gitIn, type TempRepo } from "./helpers/repo.js";
import { runScript } from "./helpers/run.js";

describe("detect-platform", () => {
  let repo: TempRepo;

  beforeEach(() => { repo = createTempRepo(); });
  afterEach(() => { repo.cleanup(); });

  it("explicit github provider returns github", () => {
    const r = runScript("detect-platform", ["--provider", "github"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("github");
  });

  it("explicit gitlab provider returns gitlab", () => {
    const r = runScript("detect-platform", ["--provider", "gitlab"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("gitlab");
  });

  it("explicit git_only returns git_only", () => {
    const r = runScript("detect-platform", ["--provider", "git_only"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("git_only");
  });

  it("github remote URL detected", () => {
    gitIn(repo.dir, ["remote", "add", "origin", "git@github.com:user/repo.git"]);
    const r = runScript("detect-platform", [], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("github");
  });

  it("bitbucket remote URL produces no error", () => {
    gitIn(repo.dir, ["remote", "add", "origin", "git@bitbucket.org:user/repo.git"]);
    const r = runScript("detect-platform", ["--provider", "auto"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    // Output depends on locally installed CLIs; just assert it's one of the known values.
    expect(["github", "gitlab", "bitbucket", "gitea", "git_only"]).toContain(r.stdout);
  });

  it("no remote and no known CLI falls back to git_only", () => {
    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const nodePath = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
    const minimalPath = [dirname(gitPath), dirname(nodePath), "/usr/bin", "/bin"]
      .filter(Boolean)
      .join(":");
    const r = runScript("detect-platform", [], {
      cwd: repo.dir,
      env: { PATH: minimalPath },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("git_only");
  });

  it("help flag shows usage", () => {
    const r = runScript("detect-platform", ["--help"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });
});
