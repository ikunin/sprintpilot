import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — CommonJS module
import adapterMod from '../../_Sprintpilot/scripts/agent-adapter.js';

const {
  HOSTS,
  detect,
  detectFromEnv,
  detectFromFilesystem,
} = adapterMod as {
  HOSTS: Record<string, { supports_parallel: boolean }>;
  detect: (opts: {
    env?: Record<string, string | undefined>;
    projectRoot?: string;
  }) => { host: string; supports_parallel: boolean; detection_reason: string; confidence: string };
  detectFromEnv: (env: Record<string, string | undefined>) => { host: string; confidence: string } | null;
  detectFromFilesystem: (root: string) => { host: string; confidence: string; detection_reason: string } | null;
};

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, '_Sprintpilot', 'scripts', 'agent-adapter.js');

let tmpRoot = '';
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sp-adapter-'));
});
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('host capability table', () => {
  it('claude-code is the only supports_parallel=true host today', () => {
    const parallel = Object.entries(HOSTS).filter(([, v]) => v.supports_parallel).map(([k]) => k);
    expect(parallel).toEqual(['claude-code']);
  });
});

describe('detectFromEnv', () => {
  it('detects claude-code via CLAUDECODE=1', () => {
    expect(detectFromEnv({ CLAUDECODE: '1' })).toEqual({
      host: 'claude-code',
      confidence: 'high',
      detection_reason: expect.stringContaining('env var'),
    });
  });

  it('detects gemini-cli via GEMINI_CLI=1', () => {
    expect(detectFromEnv({ GEMINI_CLI: '1' })?.host).toBe('gemini-cli');
  });

  it('detects gemini-cli via GEMINI_CLI_SURFACE (older subprocess env)', () => {
    expect(detectFromEnv({ GEMINI_CLI_SURFACE: 'cli' })?.host).toBe('gemini-cli');
  });

  it('detects cursor via CURSOR_SESSION_ID', () => {
    expect(detectFromEnv({ CURSOR_SESSION_ID: 'abc' })?.host).toBe('cursor');
  });

  it('returns null with no relevant env vars', () => {
    expect(detectFromEnv({})).toBeNull();
  });
});

describe('detectFromFilesystem — tautology-guard target', () => {
  it('returns low confidence and does NOT enable parallel for any FS marker', () => {
    // Create a plausible "I was installed for Claude Code" layout.
    mkdirSync(join(tmpRoot, '.claude', 'skills'), { recursive: true });
    const hit = detectFromFilesystem(tmpRoot);
    expect(hit).not.toBeNull();
    expect(hit!.host).toBe('claude-code');
    expect(hit!.confidence).toBe('low');
  });

  it('returns null when no markers are present', () => {
    expect(detectFromFilesystem(tmpRoot)).toBeNull();
  });
});

describe('detect — full decision tree', () => {
  it('env wins over filesystem, reports high confidence, and enables parallel', () => {
    mkdirSync(join(tmpRoot, '.cursor'), { recursive: true });
    const r = detect({ env: { CLAUDECODE: '1' }, projectRoot: tmpRoot });
    expect(r.host).toBe('claude-code');
    expect(r.confidence).toBe('high');
    expect(r.supports_parallel).toBe(true);
  });

  it('filesystem-only detection forces supports_parallel=false (tautology guard)', () => {
    mkdirSync(join(tmpRoot, '.claude-code'), { recursive: true });
    const r = detect({ env: {}, projectRoot: tmpRoot });
    expect(r.host).toBe('claude-code');
    expect(r.confidence).toBe('low');
    expect(r.supports_parallel).toBe(false); // the guard
  });

  it('unknown host returns confidence=low, supports_parallel=false', () => {
    const r = detect({ env: {}, projectRoot: tmpRoot });
    expect(r.host).toBe('unknown');
    expect(r.supports_parallel).toBe(false);
  });

  it('gemini-cli via env is high confidence but supports_parallel stays false (experimental)', () => {
    const r = detect({ env: { GEMINI_CLI: '1' }, projectRoot: tmpRoot });
    expect(r.host).toBe('gemini-cli');
    expect(r.confidence).toBe('high');
    // Default false because worktree-scoped subagents aren't shipped
    // upstream. Workflow-level opt-in flips this after the user sets
    // ma.experimental_parallel_on_gemini: true in config.
    expect(r.supports_parallel).toBe(false);
  });
});

describe('CLI integration', () => {
  it('detect action emits JSON to stdout', () => {
    const out = execFileSync(process.execPath, [
      SCRIPT,
      'detect',
      '--project-root',
      tmpRoot,
    ]).toString();
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('host');
    expect(parsed).toHaveProperty('confidence');
    expect(parsed).toHaveProperty('supports_parallel');
  });
});
