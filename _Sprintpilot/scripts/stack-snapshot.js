#!/usr/bin/env node

// stack-snapshot — aggregated view of the open-PR stack at session
// checkpoint time. Answers: how deep is the stack? Are any base merges
// dirty? Is CI green across the board? Which PR should land next?
//
// Drives `pr-list.js` to enumerate open PRs, then `pr-checks.js` per PR
// to gather CI state. Sorts the result topologically by `targetBranch →
// sourceBranch` chain (bottom-up = merge-order). Writes a `stack:` block
// to git-status.yaml so the next /sprint-autopilot-on session and the
// human dev can both see the picture without manually `gh pr list`-ing.
//
// Usage:
//   stack-snapshot.js --platform <p>
//                     [--branch-prefix story/]
//                     [--base-branch main]
//                     [--git-status-file <path>]
//                     [--base-url <url>]
//                     [--prs-from-file <json>] [--checks-from-file <json>]
//                     [--merge-strategy manual|land_as_you_go]
//                     [--dry-run] [--format text|json]
//
// Output (always JSON to stdout, regardless of --format):
//   { snapshot: { last_snapshot, depth, base_branch, pending_merges,
//                 conflicts_at_base, ci_all_green, recommendation },
//     wrote: <git-status path or null> }
//
// Exit codes:
//   0 — snapshot written (or dry-run).
//   1 — invalid argv.
//   2 — platform unavailable; degraded snapshot still emitted.
//
// --prs-from-file / --checks-from-file are testing hooks: they skip the
// pr-list/pr-checks subprocess spawns and read JSON fixtures directly.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { parseArgs } = require('../lib/runtime/args');
const { tryRun } = require('../lib/runtime/spawn');
const log = require('../lib/runtime/log');
const { isKnownPlatform } = require('../lib/runtime/platform');

const SCRIPT_DIR = __dirname;

function help() {
  log.out(
    'Usage: stack-snapshot.js --platform <p> [--branch-prefix story/] [--base-branch main] [--git-status-file <path>] [--base-url <url>] [--merge-strategy manual|land_as_you_go] [--dry-run]',
  );
}

// =============================================================================
// Topology
// =============================================================================
//
// Each PR has a sourceBranch (head) and a targetBranch (base). The "stack
// floor" is the project's base branch (typically main/master). A PR that
// targets the floor has depth 0; a PR that targets another PR's source
// branch has depth = parent.depth + 1. We sort by depth ascending so the
// caller can land bottom-up.

function computeDepth(prs, baseBranch) {
  const byBranch = new Map();
  for (const pr of prs) {
    if (pr.sourceBranch) byBranch.set(pr.sourceBranch, pr);
  }
  const cache = new Map();

  function visit(pr, seen) {
    if (cache.has(pr.sourceBranch)) return cache.get(pr.sourceBranch);
    // Cycle protection — shouldn't happen in real PR graphs, but a
    // misconfigured platform listing could send us spinning. We return 0
    // on cycle but DO NOT cache: the value is determined by traversal
    // order, not by the branch's actual depth, so caching would poison
    // future independent traversals that legitimately reference this
    // branch (e.g. a self-cycle on a stale branch shared with a real
    // open PR).
    if (seen.has(pr.sourceBranch)) return 0;
    if (pr.targetBranch === baseBranch || !pr.targetBranch) {
      cache.set(pr.sourceBranch, 0);
      return 0;
    }
    const parent = byBranch.get(pr.targetBranch);
    if (!parent) {
      // Targets a branch outside the open-PR set (e.g. a release branch).
      // Treat as floor — we have no further visibility.
      cache.set(pr.sourceBranch, 0);
      return 0;
    }
    seen.add(pr.sourceBranch);
    const d = 1 + visit(parent, seen);
    cache.set(pr.sourceBranch, d);
    return d;
  }

  return prs.map((pr) => ({ ...pr, depth: visit(pr, new Set()) }));
}

function topologicalOrder(prs) {
  // depth ascending, then PR number ascending for stable ordering.
  return [...prs].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const an = Number(a.number) || 0;
    const bn = Number(b.number) || 0;
    return an - bn;
  });
}

// =============================================================================
// Recommendation
// =============================================================================

function buildRecommendation({ depth, ciAllGreen, dirtyPrs, mergeStrategy }) {
  if (depth === 0) return null;
  if (dirtyPrs && dirtyPrs.length > 0) {
    // Dirty merge state lives on the platform side — the conflict
    // doesn't exist in the user's worktree yet, so `resolve-docs`
    // (which only operates on already-conflicted working-tree files
    // with `<<<<<<<` markers) has nothing to act on. The actual fix is
    // `land-stack`, which fetches each branch, runs `git merge` to
    // surface the conflicts locally (the auto-merge driver from chunk
    // 1 then resolves the BMad state files automatically), and pushes
    // the rebased branch back. The user only needs to step in for
    // real-code conflicts the driver can't handle.
    const list = dirtyPrs.map((p) => `#${p.pr}`).join(', ');
    return (
      `Stack has dirty merge state on PR ${list} — run \`sprintpilot land-stack\` ` +
      'to rebase each PR on the latest base. The auto-merge driver resolves BMad ' +
      'state-file conflicts; real-code conflicts surface for manual resolution.'
    );
  }
  if (ciAllGreen) {
    const plural = depth > 1 ? 's' : '';
    return `Stack is healthy and ready to land — run \`sprintpilot land-stack\` to merge ${depth} PR${plural} bottom-up.`;
  }
  if (depth >= 3 && mergeStrategy === 'manual') {
    return 'Stack is deep and growing — consider `autopilot.merge_strategy: land_as_you_go` for the next session to merge each story as CI greens.';
  }
  return null;
}

// =============================================================================
// Subprocess invocation: pr-list + pr-checks
// =============================================================================

async function fetchPrs({ platform, branchPrefix, baseUrl }) {
  const args = ['--platform', platform, '--state', 'open'];
  if (branchPrefix) args.push('--branch-prefix', branchPrefix);
  if (baseUrl) args.push('--base-url', baseUrl);
  const r = await tryRun('node', [path.join(SCRIPT_DIR, 'pr-list.js'), ...args], {
    timeoutMs: 60_000,
  });
  // pr-list always emits JSON; exit 2 means "platform unavailable, prs=[]".
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return {
      ok: false,
      reason: `pr-list emitted non-JSON: ${e.message}; stderr: ${r.stderr.trim().slice(0, 200)}`,
      prs: [],
    };
  }
  if (parsed.skipped || parsed.error) {
    return { ok: false, reason: parsed.skipped || parsed.error, prs: parsed.prs || [] };
  }
  return { ok: true, prs: parsed.prs || [] };
}

async function fetchChecks({ platform, baseUrl, pr }) {
  const args = ['--platform', platform, '--pr', String(pr.number)];
  if (baseUrl) args.push('--base-url', baseUrl);
  const r = await tryRun('node', [path.join(SCRIPT_DIR, 'pr-checks.js'), ...args], {
    timeoutMs: 60_000,
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { state: 'unknown', error: r.stderr.trim().slice(0, 200) };
  }
}

// =============================================================================
// Snapshot composition
// =============================================================================

function composeSnapshot({ prs, baseBranch, branchPrefix, mergeStrategy, fetchedAt }) {
  const withDepth = computeDepth(prs, baseBranch);
  const sorted = topologicalOrder(withDepth);
  const pending = sorted.map((pr) => ({
    story:
      branchPrefix && pr.sourceBranch?.startsWith(branchPrefix)
        ? pr.sourceBranch.slice(branchPrefix.length)
        : null,
    pr: pr.number,
    sourceBranch: pr.sourceBranch,
    base: pr.targetBranch,
    mergeStateStatus: pr.mergeStateStatus || 'UNKNOWN',
    ci: pr.ci || 'unknown',
    depth: pr.depth,
  }));
  const ciAllGreen = pending.length > 0 && pending.every((p) => p.ci === 'success');
  const dirtyPrs = pending.filter((p) => (p.mergeStateStatus || '').toUpperCase() === 'DIRTY');
  const conflictsAtBase = dirtyPrs.length > 0;
  const depth = pending.length;
  const recommendation = buildRecommendation({
    depth,
    ciAllGreen,
    dirtyPrs,
    mergeStrategy,
  });
  return {
    last_snapshot: fetchedAt,
    depth,
    base_branch: baseBranch,
    pending_merges: pending,
    // `conflicts_at_base` keeps the existing field name for back-compat
    // with the YAML consumers; `dirty_prs` is the more accurate
    // surface — list of PR numbers that report DIRTY merge state.
    conflicts_at_base: conflictsAtBase,
    dirty_prs: dirtyPrs.map((p) => p.pr),
    ci_all_green: ciAllGreen,
    recommendation: recommendation || '',
  };
}

// =============================================================================
// YAML emission for the `stack:` block + atomic write
// =============================================================================
//
// We do NOT use yaml-lite here — it speaks story blocks, not arbitrary
// nested mappings. Hand-emitted YAML is fine because the shape is fixed
// and we control every value (sanitize quote special chars).

function escYaml(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  if (s === '') return '""';
  if (
    /[:{}[\],&*#?|<>=!%@`\n]|^-|^\s|\s$/.test(s) ||
    /^(true|false|yes|no|null|on|off|~)$/i.test(s)
  ) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

function renderStackYaml(snapshot) {
  const lines = [];
  lines.push('stack:');
  lines.push(`  last_snapshot: ${escYaml(snapshot.last_snapshot)}`);
  lines.push(`  depth: ${snapshot.depth}`);
  lines.push(`  base_branch: ${escYaml(snapshot.base_branch)}`);
  lines.push(`  ci_all_green: ${snapshot.ci_all_green ? 'true' : 'false'}`);
  lines.push(`  conflicts_at_base: ${snapshot.conflicts_at_base ? 'true' : 'false'}`);
  if (snapshot.dirty_prs && snapshot.dirty_prs.length > 0) {
    // Run each PR identifier through escYaml — they're integers today on
    // every supported platform, but a defensive escape keeps us safe if
    // a future provider returns a non-numeric ID (or a number that
    // collides with a YAML reserved literal once stringified).
    lines.push(`  dirty_prs: [${snapshot.dirty_prs.map((p) => escYaml(p)).join(', ')}]`);
  }
  if (snapshot.pending_merges.length === 0) {
    lines.push('  pending_merges: []');
  } else {
    lines.push('  pending_merges:');
    for (const p of snapshot.pending_merges) {
      lines.push(
        `    - { story: ${escYaml(p.story)}, pr: ${escYaml(p.pr)}, base: ${escYaml(p.base)}, source: ${escYaml(p.sourceBranch)}, merge_state: ${escYaml(p.mergeStateStatus)}, ci: ${escYaml(p.ci)} }`,
      );
    }
  }
  if (snapshot.recommendation) {
    lines.push(`  recommendation: ${escYaml(snapshot.recommendation)}`);
  }
  return `${lines.join('\n')}\n`;
}

// Replace an existing `stack:` top-level block in `text` with `newBlock`.
// If no block is present, append `newBlock` at end-of-file with a leading
// blank line. The block runs from the `stack:` header through the last
// indented continuation line.
function upsertStackBlock(text, newBlock) {
  const m = text.match(/^stack:[ \t]*$/m);
  const trimmedNew = newBlock.replace(/\s+$/, '');
  if (!m) {
    const trimmed = text.replace(/\s+$/, '');
    if (trimmed === '') return `${trimmedNew}\n`;
    return `${trimmed}\n\n${trimmedNew}\n`;
  }
  const startIdx = m.index;
  const lines = text.split('\n');
  const startLine = text.slice(0, startIdx).split('\n').length - 1;
  let i = startLine + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    if (line.startsWith('  ') || line.startsWith('\t')) continue;
    break;
  }
  // Strip trailing blanks consumed past the block.
  let endIdx = 0;
  for (let j = 0, n = 0; j < text.length && n <= i; j++) {
    if (text[j] === '\n') {
      n++;
      if (n === i) {
        endIdx = j + 1;
        break;
      }
    }
  }
  if (endIdx === 0) endIdx = text.length;
  return `${text.slice(0, startIdx).replace(/\s+$/, '')}\n\n${trimmedNew}\n${text.slice(endIdx).replace(/^\s+/, '')}`.replace(
    /\n+$/,
    '\n',
  );
}

function atomicWrite(targetPath, content) {
  const dir = path.dirname(targetPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const suffix = crypto.randomBytes(4).toString('hex');
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${suffix}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, targetPath);
  } catch (e) {
    if (e.code === 'EXDEV') {
      // Fall back to direct write — same risk as sync-status.js's atomicWrite;
      // acceptable on the rare cross-FS rename.
      try {
        fs.writeFileSync(targetPath, content, 'utf8');
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best effort */
        }
      }
      return;
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const { opts } = parseArgs(process.argv.slice(2), { booleanFlags: ['dry-run'] });
  if (opts.help) {
    help();
    process.exit(0);
  }

  const platform = opts.platform;
  const branchPrefix = opts['branch-prefix'] || 'story/';
  const baseBranch = opts['base-branch'] || 'main';
  const baseUrl = opts['base-url'];
  const gitStatusFile = opts['git-status-file'];
  const mergeStrategy = opts['merge-strategy'] || 'manual';
  const dryRun = !!opts['dry-run'];
  const prsFromFile = opts['prs-from-file'];
  const checksFromFile = opts['checks-from-file'];

  if (!isKnownPlatform(platform)) {
    log.error(`unknown or missing --platform '${platform || ''}'`);
    help();
    process.exit(1);
  }

  let prs = [];
  let degradedReason = null;
  if (prsFromFile) {
    prs = JSON.parse(fs.readFileSync(prsFromFile, 'utf8')).prs || [];
  } else if (platform === 'git_only') {
    degradedReason = 'git_only platform: no PR data available';
  } else {
    const r = await fetchPrs({ platform, branchPrefix, baseUrl });
    if (!r.ok) {
      degradedReason = r.reason;
      prs = r.prs;
    } else {
      prs = r.prs;
    }
  }

  // Decorate PRs with CI state (one subprocess per PR — could be batched
  // in a future round; for now we accept the cost since stack depth is
  // small in practice).
  if (checksFromFile) {
    const checksMap = JSON.parse(fs.readFileSync(checksFromFile, 'utf8'));
    prs = prs.map((pr) => ({ ...pr, ci: checksMap[String(pr.number)] || 'unknown' }));
  } else if (!degradedReason && prs.length > 0) {
    for (const pr of prs) {
      const checks = await fetchChecks({ platform, baseUrl, pr });
      pr.ci = checks.state || 'unknown';
    }
  }

  const snapshot = composeSnapshot({
    prs,
    baseBranch,
    branchPrefix,
    mergeStrategy,
    fetchedAt: new Date().toISOString(),
  });
  if (degradedReason) snapshot.degraded = degradedReason;

  let wrote = null;
  if (gitStatusFile && !dryRun) {
    const existing = fs.existsSync(gitStatusFile) ? fs.readFileSync(gitStatusFile, 'utf8') : '';
    const updated = upsertStackBlock(existing, renderStackYaml(snapshot));
    atomicWrite(gitStatusFile, updated);
    wrote = gitStatusFile;
  }

  log.out(JSON.stringify({ snapshot, wrote }));
  if (degradedReason) process.exit(2);
}

module.exports = {
  computeDepth,
  topologicalOrder,
  composeSnapshot,
  buildRecommendation,
  renderStackYaml,
  upsertStackBlock,
  escYaml,
};

if (require.main === module) {
  main().catch((e) => {
    log.error(e.message || String(e));
    process.exit(1);
  });
}
