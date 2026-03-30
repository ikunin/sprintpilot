/**
 * E2E test assertion helpers — verify file system, YAML state, and git state.
 */
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

// ── File system assertions ──

export function assertFileExists(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Expected file to exist: ${path}`);
  }
}

export function assertDirectoryExists(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Expected directory to exist: ${path}`);
  }
}

export function assertFileContains(path: string, pattern: RegExp): void {
  assertFileExists(path);
  const content = readFileSync(path, "utf-8");
  if (!pattern.test(content)) {
    throw new Error(
      `Expected ${path} to match ${pattern}, got:\n${content.slice(0, 500)}`
    );
  }
}

export function assertFileNotEmpty(path: string): void {
  assertFileExists(path);
  const content = readFileSync(path, "utf-8").trim();
  if (content.length === 0) {
    throw new Error(`Expected ${path} to be non-empty`);
  }
}

// ── YAML state assertions ──

export function readYaml(path: string): Record<string, unknown> {
  assertFileExists(path);
  const content = readFileSync(path, "utf-8");
  return parseYaml(content) as Record<string, unknown>;
}

/**
 * Assert a nested YAML field value.
 * Path uses dot notation: "stories.1-1.status"
 */
export function assertYamlField(
  filePath: string,
  fieldPath: string,
  expected: unknown
): void {
  const data = readYaml(filePath);
  const keys = fieldPath.split(".");
  let current: unknown = data;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      throw new Error(
        `YAML field path '${fieldPath}' broken at '${key}' in ${filePath}`
      );
    }
    current = (current as Record<string, unknown>)[key];
  }

  if (current !== expected) {
    throw new Error(
      `Expected ${filePath}:${fieldPath} = ${JSON.stringify(expected)}, got ${JSON.stringify(current)}`
    );
  }
}

export function assertYamlFieldExists(
  filePath: string,
  fieldPath: string
): void {
  const data = readYaml(filePath);
  const keys = fieldPath.split(".");
  let current: unknown = data;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      throw new Error(
        `YAML field '${fieldPath}' does not exist in ${filePath}`
      );
    }
    current = (current as Record<string, unknown>)[key];
  }

  if (current === undefined || current === null) {
    throw new Error(
      `YAML field '${fieldPath}' is null/undefined in ${filePath}`
    );
  }
}

// ── Git state assertions ──

function gitExec(repoDir: string, cmd: string): string {
  return execSync(`git -C "${repoDir}" ${cmd}`, {
    encoding: "utf-8",
    timeout: 10_000,
  }).trim();
}

export function assertBranchExists(
  repoDir: string,
  branchName: string
): void {
  try {
    gitExec(repoDir, `rev-parse --verify "${branchName}"`);
  } catch {
    throw new Error(`Expected branch '${branchName}' to exist in ${repoDir}`);
  }
}

export function assertCommitMessageMatches(
  repoDir: string,
  pattern: RegExp,
  maxCommits = 10
): void {
  const log = gitExec(repoDir, `log --oneline -${maxCommits}`);
  if (!pattern.test(log)) {
    throw new Error(
      `Expected a commit matching ${pattern} in last ${maxCommits} commits:\n${log}`
    );
  }
}

export function assertCleanWorkingTree(repoDir: string): void {
  const status = gitExec(repoDir, "status --porcelain");
  if (status.length > 0) {
    throw new Error(
      `Expected clean working tree in ${repoDir}, got:\n${status}`
    );
  }
}

export function assertNoOrphanedWorktrees(repoDir: string): void {
  const list = gitExec(repoDir, "worktree list --porcelain");
  const worktrees = list
    .split("\n\n")
    .filter((block) => block.includes("worktree "));
  // First entry is always the main worktree
  if (worktrees.length > 1) {
    throw new Error(
      `Expected no orphaned worktrees in ${repoDir}, found ${worktrees.length - 1}:\n${list}`
    );
  }
}

// ── Code quality assertions ──

export function assertTestsPass(dir: string, command: string): void {
  try {
    execSync(command, {
      cwd: dir,
      encoding: "utf-8",
      timeout: 60_000,
      stdio: "pipe",
    });
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string };
    throw new Error(
      `Tests failed in ${dir}:\n${error.stdout ?? ""}\n${error.stderr ?? ""}`
    );
  }
}

export function assertMarkdownHasSections(
  filePath: string,
  sections: string[]
): void {
  assertFileExists(filePath);
  const content = readFileSync(filePath, "utf-8");
  const missing = sections.filter((s) => {
    // Match heading at any level (# through ####) at the start of a line
    const pattern = new RegExp(`^#{1,4}\\s+${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
    return !pattern.test(content);
  });
  if (missing.length > 0) {
    throw new Error(
      `${filePath} missing sections: ${missing.join(", ")}`
    );
  }
}
