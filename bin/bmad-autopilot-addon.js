#!/usr/bin/env node
const { execFileSync } = require("child_process");
const { existsSync } = require("fs");
const { join } = require("path");

const script = join(__dirname, "bmad-autopilot-addon.sh").replace(/\\/g, "/");

// On Windows, `bash` in PATH is usually WSL's bash, which cannot resolve
// Windows-style paths (C:/...). Prefer Git for Windows' bash explicitly.
function resolveBash() {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
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
