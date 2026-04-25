#!/usr/bin/env node

// agent-adapter.js — detect the host coding agent currently running the
// Sprintpilot workflow. Output informs whether parallel sub-agent
// dispatch (PR 11) is safe.
//
// Usage:
//   agent-adapter.js detect [--project-root <path>]
//
// Output (stdout, JSON):
//   {
//     "host": "claude-code" | "cursor" | "windsurf" | "aider" | "cline"
//           | "roo" | "trae" | "kiro" | "copilot" | "unknown",
//     "supports_parallel": boolean,
//     "detection_reason": string,
//     "confidence": "high" | "medium" | "low"
//   }
//
// Detection priority (first match wins):
//   1. Env vars set by the running host           → HIGH confidence
//   2. Parent process name                        → MEDIUM confidence
//   3. Filesystem install markers                 → LOW confidence
//
// Tautology guard (concept §M13): filesystem markers prove the INSTALL
// target, not the CURRENT host. confidence=low forces supports_parallel
// = false regardless of which host the markers suggest.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

// Host capability table. supports_parallel is true only for hosts with
// a first-class multi-agent API that Sprintpilot's dispatch-layer.js
// can reliably drive — which today means worktree-scoped sub-agents
// with parallel fan-out. Claude Code is the only host that meets both
// bars at the time of writing. Gemini CLI has a subagent primitive
// (invoke_subagent) but its worktree-scoped variant is still open
// upstream (github.com/google-gemini/gemini-cli#22967) and real-world
// parallelism reports serialization + quota throttling (#25534); hence
// supports_parallel=false by default, with an experimental opt-in via
// `ma.experimental_parallel_on_gemini: true` handled at workflow level.
const HOSTS = {
  'claude-code': { supports_parallel: true },
  'gemini-cli': { supports_parallel: false, subagents: 'experimental' },
  cursor: { supports_parallel: false },
  windsurf: { supports_parallel: false },
  aider: { supports_parallel: false },
  cline: { supports_parallel: false },
  roo: { supports_parallel: false },
  trae: { supports_parallel: false },
  kiro: { supports_parallel: false },
  copilot: { supports_parallel: false },
  unknown: { supports_parallel: false },
};

const ENV_DETECTORS = [
  { host: 'claude-code', match: (env) => env.CLAUDECODE === '1' || !!env.CLAUDE_CODE_SESSION_ID },
  // Gemini CLI sets GEMINI_CLI=1 for every subprocess it spawns
  // (docs/tools/shell.md + docs/reference/commands.md as of v0.33.x).
  { host: 'gemini-cli', match: (env) => env.GEMINI_CLI === '1' || !!env.GEMINI_CLI_SURFACE },
  { host: 'cursor', match: (env) => !!env.CURSOR_SESSION_ID || !!env.CURSOR_TRACE_ID },
  { host: 'windsurf', match: (env) => !!env.WINDSURF_SESSION },
  { host: 'aider', match: (env) => !!env.AIDER_SESSION || !!env.AIDER_HISTORY_FILE },
  { host: 'cline', match: (env) => !!env.CLINE_SESSION || !!env.CLINE_CONFIG },
];

const PARENT_DETECTORS = [
  { host: 'claude-code', parent: 'claude' },
  { host: 'gemini-cli', parent: 'gemini' },
  { host: 'cursor', parent: 'cursor-agent' },
  { host: 'aider', parent: 'aider' },
];

function help() {
  log.out('Usage: agent-adapter.js detect [--project-root <path>]');
}

function detectFromEnv(env) {
  for (const d of ENV_DETECTORS) {
    if (d.match(env)) {
      return { host: d.host, confidence: 'high', detection_reason: `env var set (${d.host})` };
    }
  }
  return null;
}

// Parsers extracted as pure functions so the platform branches stay
// unit-testable on any OS. Each takes the raw stdout from the platform
// command and returns the basename or null. Negative test cases
// (empty input, "INFO: No tasks…", malformed lines) covered by tests.

/** Parse `ps -p <pid> -o comm=` output (POSIX). */
function parsePsOutput(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return path.basename(trimmed.split(/\s+/)[0]);
}

/**
 * Parse `tasklist /FO CSV /NH` output (Windows). Strips `.exe` so the
 * basename matches the POSIX path (so PARENT_DETECTORS only needs the
 * non-extension name once).
 *   Sample row: "claude.exe","12345","Console","1","123,456 K"
 */
function parseTasklistOutput(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /^INFO:/i.test(trimmed)) return null; // "INFO: No tasks…"
  const m = trimmed.match(/^"([^"]+)"/);
  if (!m) return null;
  return path.basename(m[1]).replace(/\.exe$/i, '');
}

function parentProcessName() {
  try {
    const pid = process.ppid;
    if (process.platform === 'win32') {
      const res = spawnSync(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      if (res.status !== 0) return null;
      return parseTasklistOutput(res.stdout || '');
    }
    // POSIX: macOS and Linux both support `ps -p <pid> -o comm=`.
    const res = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0) return null;
    return parsePsOutput(res.stdout || '');
  } catch {
    return null;
  }
}

function detectFromParent() {
  const parent = parentProcessName();
  if (!parent) return null;
  for (const d of PARENT_DETECTORS) {
    if (parent === d.parent) {
      return {
        host: d.host,
        confidence: 'medium',
        detection_reason: `parent process '${parent}'`,
      };
    }
  }
  return null;
}

function detectFromFilesystem(projectRoot) {
  const markers = [
    { path: path.join(projectRoot, '.claude', 'skills'), host: 'claude-code' },
    { path: path.join(projectRoot, '.claude-code'), host: 'claude-code' },
    { path: path.join(projectRoot, '.cursor'), host: 'cursor' },
    { path: path.join(projectRoot, '.windsurf'), host: 'windsurf' },
    { path: path.join(projectRoot, '.aider.conf.yml'), host: 'aider' },
    { path: path.join(projectRoot, '.cline'), host: 'cline' },
  ];
  for (const m of markers) {
    if (fs.existsSync(m.path)) {
      return {
        host: m.host,
        confidence: 'low',
        detection_reason: `filesystem marker '${path.relative(projectRoot, m.path)}' — NOT proof of current host`,
      };
    }
  }
  return null;
}

function detect({ env = process.env, projectRoot = process.cwd() } = {}) {
  const fromEnv = detectFromEnv(env);
  if (fromEnv) {
    const caps = HOSTS[fromEnv.host] || HOSTS.unknown;
    return {
      host: fromEnv.host,
      supports_parallel: caps.supports_parallel,
      detection_reason: fromEnv.detection_reason,
      confidence: 'high',
    };
  }
  const fromParent = detectFromParent();
  if (fromParent) {
    const caps = HOSTS[fromParent.host] || HOSTS.unknown;
    return {
      host: fromParent.host,
      supports_parallel: caps.supports_parallel,
      detection_reason: fromParent.detection_reason,
      confidence: 'medium',
    };
  }
  const fromFs = detectFromFilesystem(projectRoot);
  if (fromFs) {
    // Tautology guard: filesystem markers never enable parallel.
    return {
      host: fromFs.host,
      supports_parallel: false,
      detection_reason: fromFs.detection_reason,
      confidence: 'low',
    };
  }
  return {
    host: 'unknown',
    supports_parallel: false,
    detection_reason: 'no env/parent/filesystem signal',
    confidence: 'low',
  };
}

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    help();
    process.exit(opts.help ? 0 : 1);
  }
  const action = positional[0];
  if (action !== 'detect') {
    log.error(`unknown action '${action}'. Valid: detect`);
    process.exit(1);
  }
  const projectRoot = opts['project-root'] || process.cwd();
  const result = detect({ env: process.env, projectRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  HOSTS,
  ENV_DETECTORS,
  PARENT_DETECTORS,
  detectFromEnv,
  detectFromParent,
  detectFromFilesystem,
  detect,
  parsePsOutput,
  parseTasklistOutput,
};

if (require.main === module) {
  main();
}
