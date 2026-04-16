import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
export const SCRIPTS_DIR = join(REPO_ROOT, "_bmad-addons", "scripts");
export const BIN_CLI = join(REPO_ROOT, "bin", "bmad-autopilot-addon.js");

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function normalize(buf: string | Buffer | null): string {
  if (buf == null) return "";
  return (typeof buf === "string" ? buf : buf.toString("utf8")).replace(/\s+$/, "");
}

export function runScript(name: string, args: string[] = [], opts: SpawnSyncOptions = {}): RunResult {
  const scriptPath = join(SCRIPTS_DIR, `${name}.js`);
  const res = spawnSync("node", [scriptPath, ...args], {
    encoding: "utf8",
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
  const res = spawnSync("node", [BIN_CLI, ...args], {
    encoding: "utf8",
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
