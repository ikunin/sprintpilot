import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// PR 10 audit: no command inside workflow.md or any Sprintpilot script
// should treat `<worktree>/.git` as a directory. In a git worktree the
// `.git` entry is a file pointing at the parent repo's `.git/worktrees/
// <name>/`, so `ls <worktree>/.git/refs/...` and friends break silently.
// Use `git -C <worktree> rev-parse --git-dir` or similar git porcelain
// instead.

const REPO_ROOT = join(__dirname, '..', '..');
const WORKFLOW_MD = join(REPO_ROOT, '_Sprintpilot', 'skills', 'sprint-autopilot-on', 'workflow.md');
const SCRIPTS_DIR = join(REPO_ROOT, '_Sprintpilot', 'scripts');

// Patterns that would misbehave inside a worktree. Kept specific — broad
// globs like /\.git/ match commentary too often.
const BAD_PATTERNS: RegExp[] = [
  // `ls .git/...` inside a worktree context
  /\bls\s+[^\s]*\.git\/(?!modules\b)/g,
  // `cat .git/HEAD` — .git is a file pointer in a worktree
  /\bcat\s+[^\s]*\.git\/(?:HEAD|refs|config)\b/g,
  // find/grep into .git/ as if it's a directory
  /\bfind\s+[^\s]*\.git\s/g,
  /\bgrep\s+[^\s]*\.git\/(?:refs|objects|hooks)\b/g,
];

// Reading-files under the MAIN repo's .git is fine — audit only targets
// "worktree context". Exempt occurrences that appear in comments or that
// document safe alternatives.
function isAuditContext(lineOrBlock: string): boolean {
  // A rough heuristic: if the line mentions .worktrees or worktree context
  // and the bad pattern matches on the SAME line, flag it.
  return /worktree|\.worktrees/i.test(lineOrBlock);
}

function readScripts(): Array<{ path: string; body: string }> {
  const out: Array<{ path: string; body: string }> = [];
  const files = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    out.push({ path: join(SCRIPTS_DIR, f), body: readFileSync(join(SCRIPTS_DIR, f), 'utf8') });
  }
  return out;
}

function scanForBadPatterns(body: string): string[] {
  const hits: string[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of BAD_PATTERNS) {
      const matches = line.match(new RegExp(re.source, re.flags)) || [];
      for (const m of matches) {
        if (isAuditContext(line)) {
          hits.push(`L${i + 1}: ${m.trim()}  // ${line.trim()}`);
        }
      }
    }
  }
  return hits;
}

describe('PR 10 worktree-path audit', () => {
  it('workflow.md contains no worktree-context access that treats .git as a directory', () => {
    const body = readFileSync(WORKFLOW_MD, 'utf8');
    const hits = scanForBadPatterns(body);
    expect(hits, `workflow.md contains worktree-unsafe .git paths:\n${hits.join('\n')}`).toEqual(
      [],
    );
  });

  it('no Sprintpilot script treats a worktree .git as a directory', () => {
    const scripts = readScripts();
    const failures: string[] = [];
    for (const { path, body } of scripts) {
      const hits = scanForBadPatterns(body);
      if (hits.length) failures.push(`${path}:\n  ${hits.join('\n  ')}`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
