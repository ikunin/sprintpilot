import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "./helpers/repo.js";
import { runScript } from "./helpers/run.js";

describe("lock", () => {
  let repo: TempRepo;

  beforeEach(() => { repo = createTempRepo(); });
  afterEach(() => { repo.cleanup(); });

  it("check on free returns FREE", () => {
    const r = runScript("lock", ["check"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("FREE");
  });

  it("acquire on free succeeds", () => {
    const r = runScript("lock", ["acquire"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("ACQUIRED:")).toBe(true);
    expect(existsSync(join(repo.dir, ".autopilot.lock"))).toBe(true);
  });

  it("check after acquire returns LOCKED", () => {
    runScript("lock", ["acquire"], { cwd: repo.dir });
    const r = runScript("lock", ["check"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("LOCKED:")).toBe(true);
  });

  it("double acquire fails with LOCKED", () => {
    runScript("lock", ["acquire"], { cwd: repo.dir });
    const r = runScript("lock", ["acquire"], { cwd: repo.dir });
    expect(r.status).toBe(1);
    expect(r.stdout.startsWith("LOCKED:")).toBe(true);
  });

  it("release after acquire succeeds", () => {
    runScript("lock", ["acquire"], { cwd: repo.dir });
    const r = runScript("lock", ["release"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("RELEASED");
    expect(existsSync(join(repo.dir, ".autopilot.lock"))).toBe(false);
  });

  it("release when no lock returns NO_LOCK", () => {
    const r = runScript("lock", ["release"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("NO_LOCK");
  });

  it("stale lock is auto-acquired", () => {
    const oldTime = Math.floor(Date.now() / 1000) - 1900;
    writeFileSync(join(repo.dir, ".autopilot.lock"), `${oldTime}\nstale-session-id\n`, "utf8");
    const r = runScript("lock", ["acquire"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("ACQUIRED_STALE:")).toBe(true);
  });

  it("stale lock detected by check", () => {
    const oldTime = Math.floor(Date.now() / 1000) - 1900;
    writeFileSync(join(repo.dir, ".autopilot.lock"), `${oldTime}\nstale-session-id\n`, "utf8");
    const r = runScript("lock", ["check"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("STALE:")).toBe(true);
  });

  it("status on free shows free message", () => {
    const r = runScript("lock", ["status"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("free");
  });

  it("status on locked shows ACTIVE", () => {
    runScript("lock", ["acquire"], { cwd: repo.dir });
    const r = runScript("lock", ["status"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ACTIVE");
  });

  it("status on stale shows STALE", () => {
    const oldTime = Math.floor(Date.now() / 1000) - 1900;
    writeFileSync(join(repo.dir, ".autopilot.lock"), `${oldTime}\nstale-session-id\n`, "utf8");
    const r = runScript("lock", ["status"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("STALE");
  });

  it("custom lock file path works", () => {
    const r = runScript("lock", ["acquire", "--file", "custom.lock"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(existsSync(join(repo.dir, "custom.lock"))).toBe(true);
    expect(existsSync(join(repo.dir, ".autopilot.lock"))).toBe(false);
  });

  it("custom stale minutes works", () => {
    const oldTime = Math.floor(Date.now() / 1000) - 600; // 10 min old
    writeFileSync(join(repo.dir, ".autopilot.lock"), `${oldTime}\nold-session\n`, "utf8");
    const r = runScript("lock", ["acquire", "--stale-minutes", "5"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("ACQUIRED_STALE:")).toBe(true);
  });

  it("missing action fails", () => {
    const r = runScript("lock", [], { cwd: repo.dir });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("action required");
  });

  it("lock file contains epoch and uuid", () => {
    runScript("lock", ["acquire"], { cwd: repo.dir });
    const raw = readFileSync(join(repo.dir, ".autopilot.lock"), "utf8");
    const lines = raw.trim().split(/\n/);
    expect(lines.length).toBe(2);
    expect(/^\d+$/.test(lines[0])).toBe(true);
  });

  it("help flag shows usage", () => {
    const r = runScript("lock", ["--help"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  // Regression: corrupted lock file (garbage first line) must NOT be auto-evicted
  it("garbage in lock file is treated as LOCKED, not STALE", () => {
    writeFileSync(join(repo.dir, ".autopilot.lock"), "not-a-number\nsession-id\n", "utf8");
    const r = runScript("lock", ["check"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("LOCKED:")).toBe(true);
  });

  // Regression: acquire against garbage lock file must refuse, not take over
  it("acquire against corrupt lock file fails with LOCKED", () => {
    writeFileSync(join(repo.dir, ".autopilot.lock"), "garbage\n", "utf8");
    const r = runScript("lock", ["acquire"], { cwd: repo.dir });
    expect(r.status).toBe(1);
    expect(r.stdout.startsWith("LOCKED:")).toBe(true);
  });

  // Regression: future-dated lock (clock skew) is detected as STALE, not locked forever
  it("future-dated lock file is treated as STALE", () => {
    const futureTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour ahead
    writeFileSync(join(repo.dir, ".autopilot.lock"), `${futureTime}\nfuture-session\n`, "utf8");
    const r = runScript("lock", ["check"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("STALE:")).toBe(true);
  });

  // Regression: acquire against future-dated lock takes it over as STALE
  it("acquire against future-dated lock succeeds with ACQUIRED_STALE", () => {
    const futureTime = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(join(repo.dir, ".autopilot.lock"), `${futureTime}\nfuture-session\n`, "utf8");
    const r = runScript("lock", ["acquire"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("ACQUIRED_STALE:")).toBe(true);
  });

  // Regression: lockfile path that is a directory must not be overwritten
  it("non-file lock path (directory) is treated as LOCKED", () => {
    const lockPath = join(repo.dir, ".autopilot.lock");
    // Create as a directory
    require("node:fs").mkdirSync(lockPath);
    const r = runScript("lock", ["check"], { cwd: repo.dir });
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("LOCKED:")).toBe(true);
    const acquire = runScript("lock", ["acquire"], { cwd: repo.dir });
    expect(acquire.status).toBe(1);
  });
});
