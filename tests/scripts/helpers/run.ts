import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
export const SCRIPTS_DIR = join(REPO_ROOT, '_Sprintpilot', 'scripts');
export const BIN_CLI = join(REPO_ROOT, 'bin', 'sprintpilot.js');

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function normalize(buf: string | Buffer | null): string {
  if (buf == null) return '';
  return (typeof buf === 'string' ? buf : buf.toString('utf8')).replace(/\s+$/, '');
}

// Use `process.execPath` instead of literal "node" — on Windows runners
// `node` isn't always reachable through PATH (spawnSync resolves "node"
// against the runner's PATH, which can miss the Node we're actually
// running under). `process.execPath` is the absolute path to the current
// Node binary and works on every OS. Production scripts already follow
// this pattern (e.g. preflight-merge.js, submodule-lock.js).
const NODE_BIN = process.execPath;

export function runScript(
  name: string,
  args: string[] = [],
  opts: SpawnSyncOptions = {},
): RunResult {
  const scriptPath = join(SCRIPTS_DIR, `${name}.js`);
  const res = spawnSync(NODE_BIN, [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    ...opts,
    env: { ...process.env, ...(opts.env as Record<string, string> | undefined) },
  });
  if (res.error) {
    throw res.error;
  }
  return {
    stdout: normalize(res.stdout),
    stderr: normalize(res.stderr),
    status: res.status ?? 0,
  };
}

export function runCli(args: string[] = [], opts: SpawnSyncOptions = {}): RunResult {
  const res = spawnSync(NODE_BIN, [BIN_CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    ...opts,
    env: { ...process.env, ...(opts.env as Record<string, string> | undefined) },
  });
  if (res.error) {
    throw res.error;
  }
  return {
    stdout: normalize(res.stdout),
    stderr: normalize(res.stderr),
    status: res.status ?? 0,
  };
}
