/**
 * Claude Code test runner — spawns `claude -p` as a subprocess
 * and captures structured output.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface ClaudeRunOptions {
  /** Working directory for the Claude session */
  cwd: string;
  /** Maximum budget in USD (default: 15) */
  maxBudget?: number;
  /** Model to use (default: "sonnet") */
  model?: string;
  /** Additional directories to allow access to */
  addDirs?: string[];
  /** Timeout in ms (default: 600000 = 10 min) */
  timeout?: number;
  /** System prompt override */
  systemPrompt?: string;
  /** Append to system prompt */
  appendSystemPrompt?: string;
}

export interface ClaudeRunResult {
  /** Exit code of the claude process */
  exitCode: number;
  /** Full stdout text */
  stdout: string;
  /** Full stderr text */
  stderr: string;
  /** Whether the process was killed due to timeout */
  timedOut: boolean;
  /** Parsed JSON result (if output-format was json) */
  json?: {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    result?: string;
    total_cost_usd?: number;
    duration_ms?: number;
    num_turns?: number;
    session_id?: string;
  };
}

/**
 * Run a prompt through Claude Code non-interactively.
 *
 * NOTE: We do NOT use --bare because it disables OAuth/keychain auth
 * (only ANTHROPIC_API_KEY works in bare mode). Instead we use targeted
 * flags for isolation.
 */
export async function runClaude(
  prompt: string,
  options: ClaudeRunOptions
): Promise<ClaudeRunResult> {
  const {
    cwd,
    maxBudget = 15,
    model = "sonnet",
    addDirs = [],
    timeout = 600_000,
    systemPrompt,
    appendSystemPrompt,
  } = options;

  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--max-budget-usd",
    String(maxBudget),
    "--model",
    model,
  ];

  for (const dir of addDirs) {
    args.push("--add-dir", dir);
  }

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }

  return new Promise<ClaudeRunResult>((resolve) => {
    let resolved = false;
    const finish = (result: ClaudeRunResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    const proc: ChildProcess = spawn("claude", args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Handle spawn failures (e.g., claude binary not found)
    proc.on("error", (err) => {
      finish({
        exitCode: 1,
        stdout,
        stderr: `spawn error: ${err.message}`,
        timedOut: false,
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // Try SIGTERM first to allow graceful shutdown and JSON output
      proc.kill("SIGTERM");
      // Force kill after 10s if SIGTERM is ignored
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 10_000);
    }, timeout);

    proc.on("close", (code) => {
      let json: ClaudeRunResult["json"];
      try {
        json = JSON.parse(stdout);
      } catch {
        // Output was not valid JSON
      }

      // Log auth/error issues for debugging
      if (json?.is_error) {
        console.error(`[claude-runner] ERROR: ${json.result}`);
      }

      finish({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
        json,
      });
    });
  });
}

/**
 * Run a BMAD skill via Claude Code.
 * Wraps the skill invocation with appropriate context.
 */
export async function runSkill(
  skillName: string,
  options: ClaudeRunOptions & { extraPrompt?: string }
): Promise<ClaudeRunResult> {
  const prompt = options.extraPrompt
    ? `/${skillName}\n\n${options.extraPrompt}`
    : `/${skillName}`;

  return runClaude(prompt, options);
}
