#!/usr/bin/env node
const { execFileSync } = require("child_process");
const { join } = require("path");

const script = join(__dirname, "bmad-autopilot-addon.sh").replace(/\\/g, "/");
try {
  execFileSync("bash", [script, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, BMAD_PROJECT_ROOT: process.cwd() },
  });
} catch (e) {
  process.exit(e.status || 1);
}
