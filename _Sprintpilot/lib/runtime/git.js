const { run, tryRun } = require('./spawn');

async function git(args, opts = {}) {
  return run('git', args, opts);
}

async function tryGit(args, opts = {}) {
  return tryRun('git', args, opts);
}

async function gitStdout(args, opts = {}) {
  const { stdout } = await git(args, opts);
  return stdout.trim();
}

async function tryGitStdout(args, opts = {}) {
  const r = await tryGit(args, opts);
  if (r.exitCode !== 0) return null;
  return r.stdout.trim();
}

module.exports = { git, tryGit, gitStdout, tryGitStdout };
