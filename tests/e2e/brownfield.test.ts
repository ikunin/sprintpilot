/**
 * E2E Brownfield Test: json-server analysis + feature development
 *
 * Exercises the brownfield pipeline:
 *   codebase-map → assess → reverse-architect → (optional: migrate) →
 *   autopilot feature development with regression validation
 *
 * Requires: git, node, npm
 * Run: npm run test:e2e:brownfield
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { runClaude, runSkill } from "./harness/claude-runner.js";
import {
  assertFileExists,
  assertFileNotEmpty,
  assertDirectoryExists,
} from "./harness/assertions.js";
import { costTracker } from "./harness/cost-tracker.js";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures/brownfield");
const ADDON_SOURCE = join(import.meta.dirname, "../../_bmad-addons");

let projectDir: string;
let remoteDir: string | undefined;

function exec(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd: cwd ?? projectDir,
    encoding: "utf-8",
    timeout: 120_000,
  }).trim();
}

describe("Brownfield: json-server analysis + auth feature", () => {
  beforeAll(async () => {
    // Clone json-server v0.17.x into a temp directory
    const { mkdtempSync, cpSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    projectDir = mkdtempSync(join(tmpdir(), "bmad-brownfield-"));
    console.log(`[Brownfield] Temp project: ${projectDir}`);

    // Clone json-server v0.17.3 (v0.17.4 tag has issues with shallow clone)
    try {
      execSync(
        `git clone --depth 1 --branch v0.17.3 https://github.com/typicode/json-server.git "${projectDir}/src"`,
        { timeout: 60_000, encoding: "utf-8" }
      );
      // Move contents up and remove wrapper
      execSync(
        `shopt -s dotglob && mv "${projectDir}/src/"* "${projectDir}/" 2>/dev/null; rm -rf "${projectDir}/src"`,
        { timeout: 10_000, encoding: "utf-8", shell: "/bin/bash" }
      );
    } catch (e) {
      console.error("Failed to clone json-server:", e);
      throw e;
    }

    // Initialize fresh git history
    exec("rm -rf .git");
    exec("git init --initial-branch=main");
    exec('git config user.email "test@bmad-e2e.com"');
    exec('git config user.name "BMAD E2E Test"');
    exec("git add .");
    exec('git commit -m "import json-server v0.17.3"');

    // Create bare remote
    const { mkdtempSync: mkdtemp2 } = await import("node:fs");
    remoteDir = mkdtemp2(join(tmpdir(), "bmad-bf-remote-"));
    execSync(`git init --bare "${remoteDir}"`, { timeout: 10_000 });
    exec(`git remote add origin "${remoteDir}"`);
    exec("git push -u origin main");

    // Install BMAD core structure
    mkdirSync(join(projectDir, "_bmad/bmm"), { recursive: true });
    mkdirSync(join(projectDir, "_bmad/_config"), { recursive: true });
    writeFileSync(
      join(projectDir, "_bmad/bmm/config.yaml"),
      "project:\n  name: json-server-e2e\n"
    );
    writeFileSync(
      join(projectDir, "_bmad/_config/manifest.yaml"),
      'bmad:\n  version: "6.2.0"\n'
    );

    // Copy addon
    cpSync(ADDON_SOURCE, join(projectDir, "_bmad-addons"), {
      recursive: true,
    });

    // Copy skills to .claude/skills/
    const skillsSrc = join(ADDON_SOURCE, "skills");
    const skillsDest = join(projectDir, ".claude/skills");
    if (existsSync(skillsSrc)) {
      cpSync(skillsSrc, skillsDest, { recursive: true });
    }

    // Create output directories
    mkdirSync(join(projectDir, "_bmad-output/planning-artifacts"), {
      recursive: true,
    });
    mkdirSync(join(projectDir, "_bmad-output/implementation-artifacts"), {
      recursive: true,
    });
    mkdirSync(join(projectDir, "_bmad-output/codebase-analysis"), {
      recursive: true,
    });

    // Add gitignore
    writeFileSync(
      join(projectDir, ".gitignore"),
      ".autopilot.lock\n_bmad-output/\n_bmad-addons/\n_bmad/\n.claude/\n"
    );
    exec("git add .gitignore && git commit -m 'add gitignore'");

    // Install npm deps (ignore-scripts to skip postinstall which may fail)
    try {
      exec("npm install --ignore-scripts", projectDir);
      exec("git add . && git commit -m 'install deps' || true");
    } catch {
      console.warn("[Setup] npm install failed — tests may not pass");
    }

    console.log("[Brownfield] Setup complete");
  }, 120_000);

  afterAll(() => {
    console.log(costTracker.report());
    if (process.env.BMAD_TEST_KEEP_ON_FAIL !== "1") {
      try {
        execSync(`rm -rf "${projectDir}"`, { timeout: 10_000 });
        if (remoteDir) execSync(`rm -rf "${remoteDir}"`, { timeout: 10_000 });
      } catch { /* ignore cleanup errors */ }
    } else {
      console.log(`[Brownfield] Preserving: ${projectDir}`);
    }
  });

  it("B0: base project has valid structure", () => {
    // Validate the cloned project has expected structure (not that tests pass,
    // since json-server v0.17.3 tests may need a specific node version)
    assertFileExists(join(projectDir, "package.json"));
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
    expect(pkg.name, "cloned project should be json-server").toBe("json-server");
  }, 60_000);

  it("B1: codebase-map produces 5 analysis files", async () => {
    const result = await runClaude("/bmad-ma-codebase-map", {
      cwd: projectDir,
      maxBudget: 10,
      model: "sonnet",
      addDirs: [ADDON_SOURCE],
      timeout: 600_000,
      appendSystemPrompt:
        "You are running inside an automated e2e test. Analyze this json-server codebase. Do NOT ask any questions.",
    });

    if (result.json?.total_cost_usd) {
      costTracker.record(
        "brownfield",
        "codebase-map",
        result.json.total_cost_usd,
        result.json.duration_ms ?? 0
      );
    }

    console.log(
      `[B1] Exit: ${result.exitCode}, Cost: $${result.json?.total_cost_usd?.toFixed(4) ?? "?"}`
    );
    expect(result.timedOut, "codebase-map must not time out").toBe(false);

    const analysisDir = join(projectDir, "_bmad-output/codebase-analysis");
    const expectedFiles = [
      "stack-analysis.md",
      "architecture-analysis.md",
      "quality-analysis.md",
      "concerns-analysis.md",
      "integrations-analysis.md",
    ];

    let found = 0;
    for (const file of expectedFiles) {
      const path = join(analysisDir, file);
      if (existsSync(path)) {
        assertFileNotEmpty(path);
        found++;
      } else {
        console.warn(`[B1] Missing: ${file}`);
      }
    }

    console.log(`[B1] Found ${found}/${expectedFiles.length} analysis files`);
    expect(found).toBeGreaterThanOrEqual(3); // At least 3 of 5
  }, 700_000);

  it("B2: assess produces brownfield assessment", async () => {
    const result = await runClaude("/bmad-ma-assess", {
      cwd: projectDir,
      maxBudget: 8,
      model: "sonnet",
      addDirs: [ADDON_SOURCE],
      timeout: 600_000,
      appendSystemPrompt:
        "You are running inside an automated e2e test. Assess tech debt for this json-server project. Do NOT ask any questions.",
    });

    if (result.json?.total_cost_usd) {
      costTracker.record(
        "brownfield",
        "assess",
        result.json.total_cost_usd,
        result.json.duration_ms ?? 0
      );
    }

    console.log(
      `[B2] Exit: ${result.exitCode}, Cost: $${result.json?.total_cost_usd?.toFixed(4) ?? "?"}`
    );
    expect(result.timedOut, "assess must not time out").toBe(false);

    const assessmentPath = join(
      projectDir,
      "_bmad-output/codebase-analysis/brownfield-assessment.md"
    );
    assertFileExists(assessmentPath);
    assertFileNotEmpty(assessmentPath);
    console.log("[B2] brownfield-assessment.md ✓");
  }, 700_000);

  it("B3: reverse-architect produces architecture doc", async () => {
    const result = await runClaude("/bmad-ma-reverse-architect", {
      cwd: projectDir,
      maxBudget: 8,
      model: "sonnet",
      addDirs: [ADDON_SOURCE],
      timeout: 600_000,
      appendSystemPrompt:
        "You are running inside an automated e2e test. Extract architecture from this json-server codebase. Do NOT ask any questions.",
    });

    if (result.json?.total_cost_usd) {
      costTracker.record(
        "brownfield",
        "reverse-architect",
        result.json.total_cost_usd,
        result.json.duration_ms ?? 0
      );
    }

    console.log(
      `[B3] Exit: ${result.exitCode}, Cost: $${result.json?.total_cost_usd?.toFixed(4) ?? "?"}`
    );
    expect(result.timedOut, "reverse-architect must not time out").toBe(false);

    // Look for architecture doc in likely locations
    const possiblePaths = [
      join(projectDir, "_bmad-output/planning-artifacts/architecture.md"),
      join(projectDir, "_bmad-output/codebase-analysis/architecture.md"),
    ];

    const found = possiblePaths.find((p) => existsSync(p));
    expect(found, `architecture doc must exist in one of: ${possiblePaths.join(", ")}`).toBeDefined();
    assertFileNotEmpty(found!);
    console.log(`[B3] Architecture doc at: ${found}`);
  }, 700_000);

  it("B4: migrate produces migration plan (optional)", async () => {
    const result = await runClaude(
      '/bmad-ma-migrate\n\nTarget: Migrate from Express to Fastify',
      {
        cwd: projectDir,
        maxBudget: 10,
        model: "sonnet",
        addDirs: [ADDON_SOURCE],
        timeout: 900_000, // 15 min — 12-step migration is the heaviest skill
        appendSystemPrompt:
          "You are running inside an automated e2e test. Plan migration from Express to Fastify. Do NOT ask any questions.",
      }
    );

    if (result.json?.total_cost_usd) {
      costTracker.record(
        "brownfield",
        "migrate",
        result.json.total_cost_usd,
        result.json.duration_ms ?? 0
      );
    }

    console.log(
      `[B4] Exit: ${result.exitCode}, Cost: $${result.json?.total_cost_usd?.toFixed(4) ?? "?"}`
    );
    expect(result.timedOut, "migrate must not time out").toBe(false);

    // Check for migration artifacts
    const planPath = join(
      projectDir,
      "_bmad-output/planning-artifacts/migration-plan.md"
    );
    if (existsSync(planPath)) {
      assertFileNotEmpty(planPath);
      console.log("[B4] migration-plan.md created ✓");
    } else {
      // Migration planning is the heaviest skill and may not always complete
      console.warn("[B4] migration-plan.md not created — acceptable for optional step");
    }
  }, 1_000_000); // 16 min — migration is the heaviest skill
});
