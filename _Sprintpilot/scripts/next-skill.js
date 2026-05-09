#!/usr/bin/env node

// next-skill — deterministic profile-aware skill routing. Replaces the
// LLM-evaluated `<check if="{{implementation_flow}} is quick AND ...">`
// prose in the autopilot workflow. The LLM only has to: run this script
// with the BMad-recommended skill, capture stdout, invoke that skill.
//
// Why a script: under prompt-size pressure, Sonnet (and even Opus) elide
// multi-clause `<check if>` evaluations in long workflows. The nano e2e
// test failed both at v2.0.9 byte-identical AND with my changes because
// the LLM stopped evaluating the routing conditions. Pulling the routing
// into a deterministic helper removes the LLM from the decision loop —
// the profile rules ALWAYS apply, regardless of context pressure.
//
// Usage:
//   next-skill.js --proposed <skill> [--implementation-flow quick|full]
//                 [--project-root <path>]
//
// Output:
//   stdout: the actual skill name to invoke (one line, no trailing
//           punctuation). LLM uses this directly with the Skill tool.
//   stderr: routing decision rationale (e.g. "routed bmad-dev-story →
//           bmad-quick-dev per nano profile"). LLM may include in logs.
//
// Exit codes:
//   0 — routed successfully
//   1 — invalid argv

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { parseArgs } = require('../lib/runtime/args');
const log = require('../lib/runtime/log');

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = __dirname;

// Skills that quick-dev replaces in the nano flow. The proposed skill
// from BMad's "Next Steps" output gets remapped to bmad-quick-dev when
// the active profile sets implementation_flow=quick.
const QUICK_FLOW_REROUTE_SET = new Set([
  'bmad-dev-story',
  'bmad-create-story',
  'bmad-check-implementation-readiness',
  'bmad-code-review',
]);

async function resolveImplementationFlow(projectRoot) {
  // Use resolve-profile.js so this script honors the same profile
  // resolution as the rest of the workflow. Falls back to 'full' on any
  // error (e.g. config missing) — that matches the workflow's documented
  // default and is safe (full flow is the conservative path).
  try {
    const { stdout } = await execFileAsync(
      'node',
      [
        path.join(SCRIPT_DIR, 'resolve-profile.js'),
        'get',
        '--default',
        'full',
        '--enum',
        'full,quick',
        'autopilot.implementation_flow',
      ],
      { cwd: projectRoot, timeout: 5_000 },
    );
    return stdout.trim() || 'full';
  } catch {
    return 'full';
  }
}

function route(proposed, implementationFlow) {
  // Returns { skill: <actual>, reason: <human-readable> | null }.
  // `reason` is non-null when routing changed, so the LLM can surface
  // the decision in its log output.
  if (!proposed) {
    return { skill: '', reason: 'no proposed skill — caller must supply --proposed' };
  }
  if (implementationFlow === 'quick' && QUICK_FLOW_REROUTE_SET.has(proposed)) {
    return {
      skill: 'bmad-quick-dev',
      reason: `routed ${proposed} → bmad-quick-dev per nano profile (implementation_flow=quick)`,
    };
  }
  return { skill: proposed, reason: null };
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log.out(
      'Usage: next-skill.js --proposed <skill> [--implementation-flow quick|full] [--project-root <path>]',
    );
    process.exit(0);
  }
  const proposed = opts.proposed;
  if (!proposed) {
    log.error('--proposed <skill> is required');
    process.exit(1);
  }
  const projectRoot = opts['project-root'] || process.cwd();
  const implementationFlow =
    opts['implementation-flow'] || (await resolveImplementationFlow(projectRoot));

  const { skill, reason } = route(proposed, implementationFlow);
  if (reason) log.err(reason);
  log.out(skill);
}

module.exports = { route, QUICK_FLOW_REROUTE_SET, resolveImplementationFlow };

if (require.main === module) {
  main().catch((e) => {
    log.error(e.message || String(e));
    process.exit(1);
  });
}
