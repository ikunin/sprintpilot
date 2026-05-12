/**
 * Git helpers for e2e tests.
 *
 * Why a separate file: getLatestStoryBranch was duplicated across
 * greenfield.test.ts and sudoku.test.ts and BOTH had the same bug —
 * a branch sort by committerdate picked stale leftover branches from
 * prior runs on a shared remote. The fix needs the current sprint's
 * story-key list to filter on, which means we need a single source of
 * truth for that lookup.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Run a git command via execFile (no shell), swallow failures. */
export function gitSafe(args: string[], dir: string): string {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Read the story keys for the current sprint from sprint-status.yaml.
 * Returns the set of keys (without the `story/` branch prefix).
 *
 * Mirrors the same shape detection as
 * `_Sprintpilot/scripts/list-remaining-stories.js#parseStatuses` but is
 * intentionally minimal — we only need keys, not statuses.
 */
export function readSprintStoryKeys(projectRoot: string): Set<string> {
  const file = join(projectRoot, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml');
  if (!existsSync(file)) return new Set();
  const raw = readFileSync(file, 'utf-8');
  const keys = new Set<string>();
  const lines = raw.split(/\r?\n/);
  let inBlock = false;
  let blockIndent = -1;
  let itemIndent = -1;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^\s*#/.test(line)) continue;
    const indent = (line.match(/^[ \t]*/)?.[0] ?? '').length;
    const content = line.slice(indent);
    if (inBlock && indent <= blockIndent) {
      inBlock = false;
      itemIndent = -1;
    }
    if (!inBlock) {
      if (/^(development_status|stories)\s*:\s*$/.test(content)) {
        inBlock = true;
        blockIndent = indent;
        itemIndent = -1;
      }
      continue;
    }
    if (itemIndent < 0) itemIndent = indent;
    if (indent !== itemIndent) continue;
    // Capture key — handles `key:`, `"key":`, `'key':`, `- id: key`.
    const list = content.match(/^-\s+(?:id|key|name)\s*:\s*["']?([A-Za-z0-9][A-Za-z0-9_.-]*)["']?/);
    if (list) {
      keys.add(list[1]);
      continue;
    }
    const dict = content.match(/^["']?([A-Za-z0-9][A-Za-z0-9_.-]*)["']?\s*:/);
    if (dict) keys.add(dict[1]);
  }
  return keys;
}

/**
 * Resolve the most recent story branch belonging to the CURRENT sprint.
 *
 * Why filter to current sprint: shared GitHub remotes accumulate story
 * branches from prior test runs. A naïve `git branch -a --sort=-committerdate
 * --list 'story/*'` returns the most recently pushed branch overall, which
 * is usually a leftover from a prior run with newer commit timestamps than
 * the local-only branches of THIS run.
 *
 * Strategy: read sprint-status.yaml for the authoritative key list, then
 * keep only branches whose suffix after `story/` matches one of those keys.
 * Among the survivors, prefer remote-tracking refs (the autopilot pushes
 * them; local refs may be locked by worktrees and unable to checkout).
 *
 * Returns null when no sprint exists yet OR no matching branch is found.
 */
export function getLatestStoryBranch(projectRoot: string): string | null {
  const sprintKeys = readSprintStoryKeys(projectRoot);
  const out = gitSafe(
    [
      'branch',
      '-a',
      '--sort=-committerdate',
      '--list',
      'story/*',
      'origin/story/*',
      'remotes/origin/story/*',
    ],
    projectRoot,
  );
  if (!out) return null;
  const parsed = out
    .split('\n')
    .map((b) => b.replace(/^\s*[*+]?\s*/, '').trim())
    .filter(Boolean)
    .filter((b) => {
      const bare = b.replace(/^remotes\/origin\//, '').replace(/^origin\//, '');
      if (!bare.startsWith('story/')) return false;
      const key = bare.slice('story/'.length);
      // If we don't know the sprint keys (no sprint-status.yaml yet), accept
      // every story-prefixed branch — the prior behavior. This keeps the
      // function usable during early bootstrap.
      if (sprintKeys.size === 0) return true;
      return sprintKeys.has(key);
    });
  if (parsed.length === 0) return null;
  const remote = parsed.find((b) => b.startsWith('remotes/origin/story/'));
  if (remote) return remote.replace('remotes/origin/', 'origin/');
  return parsed[0];
}

/** Get the worktree path holding `branch`, or null if not in a worktree. */
export function getWorktreePath(projectRoot: string, branch: string): string | null {
  const list = gitSafe(['worktree', 'list', '--porcelain'], projectRoot);
  if (!list) return null;
  const blocks = list.split('\n\n');
  for (const block of blocks) {
    if (block.includes(`branch refs/heads/${branch}`)) {
      const match = block.match(/^worktree (.+)$/m);
      return match ? match[1] : null;
    }
  }
  return null;
}
