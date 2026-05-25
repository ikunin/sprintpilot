// diff.js — list files changed between the working tree and a base ref.
//
// Used by the scope resolver to feed `changedFiles` into adapter
// buildCmd(). On any git failure we return null so the caller can
// fall back to the full suite.

'use strict';

function changedFiles({ projectRoot, baseBranch }) {
  if (!projectRoot) return null;
  const base = baseBranch || 'main';
  const { execFileSync } = require('node:child_process');
  // Comparing `<base>...HEAD` gives us the full set of files modified
  // since the branch forked, which matches "everything this story
  // could have touched". `--name-only` keeps the output one path per
  // line. We also include unstaged + untracked changes via two extra
  // probes since the LLM commits at STORY_DONE — earlier phases run
  // before the commit lands.
  const seen = new Set();
  const addAll = (text) => {
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) seen.add(trimmed);
    }
  };
  function runGit(args) {
    try {
      return execFileSync('git', ['-C', projectRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
    } catch (_e) {
      return null;
    }
  }
  // 1. Committed changes since fork
  const tri = runGit(['diff', '--name-only', `${base}...HEAD`]);
  if (tri === null) return null; // git unavailable / bad ref → caller falls back to full
  addAll(tri);
  // 2. Staged-but-uncommitted
  addAll(runGit(['diff', '--name-only', '--cached']));
  // 3. Unstaged (tracked)
  addAll(runGit(['diff', '--name-only']));
  // 4. Untracked (not in .gitignore)
  addAll(runGit(['ls-files', '--others', '--exclude-standard']));
  return Array.from(seen);
}

module.exports = { changedFiles };
