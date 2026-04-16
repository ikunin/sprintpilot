#!/usr/bin/env node
const { execFileSync, execSync } = require("child_process");
const { existsSync } = require("fs");
const { join, dirname } = require("path");

const script = join(__dirname, "bmad-autopilot-addon.sh").replace(/\\/g, "/");

// On Windows, `bash` in PATH is usually WSL's bash, which cannot resolve
// Windows-style paths (C:/...). Prefer Git for Windows' bash explicitly.
function resolveBash() {
  if (process.platform !== "win32") return "bash";

  // 1. Well-known install locations
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // 2. Derive from git.exe in PATH (covers Scoop, Chocolatey, custom installs)
  try {
    const gitPath = execSync("where git", { encoding: "utf-8" })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.endsWith("git.exe") && !l.toLowerCase().includes("windowsapps"));
    if (gitPath) {
      // git.exe is typically in Git/cmd/git.exe — bash is in Git/bin/bash.exe
      const gitDir = dirname(dirname(gitPath));
      const bash = join(gitDir, "bin", "bash.exe");
      if (existsSync(bash)) return bash;
      // Some layouts have git.exe directly in Git/bin/
      const bashSibling = join(dirname(gitPath), "bash.exe");
      if (existsSync(bashSibling)) return bashSibling;
    }
  } catch (_) {
    // git not in PATH — fall through
  }

  console.error(
    "bmad-autopilot-addon: Git Bash not found. Install Git for Windows from https://git-scm.com/download/win"
  );
  process.exit(1);
}

try {
  execFileSync(resolveBash(), [script, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, BMAD_PROJECT_ROOT: process.cwd() },
  });
} catch (e) {
  process.exit(e.status || 1);
}
