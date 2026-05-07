// Shared platform helpers used by every PR-ops script (create-pr.js,
// pr-list.js, pr-checks.js, pr-merge.js).
//
// Three concerns live here:
//   1. CLI presence check (`hasCli`) — same pattern as detect-platform.js.
//   2. Git-remote → owner/repo extraction (`parseGitRemote`,
//      `extractOwnerRepo`) — must reject inputs that could inject path
//      segments into a REST URL when we fall back to the API path.
//   3. Output redaction (`redactAuth`) — strip Authorization headers and
//      common token fields before echoing API responses to logs.
//
// All helpers are pure (no module state) so a single import is safe to
// require() from any script context.

const { tryRun } = require('./spawn');
const { tryGitStdout } = require('./git');

// Allow only safe path components so a hostile remote URL can't inject
// into the REST API path. Full repo path (repo name plus any GitLab subgroup
// segments) must contain only allowed characters. Prevents inputs like
// `..`, URL-encoded slashes, or whitespace from sneaking in.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

async function hasCli(name) {
  const r = await tryRun(name, ['--version'], { timeoutMs: 2000 });
  return r.exitCode === 0;
}

function parseGitRemote(url) {
  if (!url) return null;
  let u = url.trim();
  // Strip a trailing `.git` and trailing `/` from either form.
  u = u.replace(/\.git\/?$/, '').replace(/\/$/, '');

  // SCP-style: user@host:path (e.g. git@github.com:owner/repo,
  // git@github.com-work:org/sub/repo). Exclude URL-scheme inputs from this
  // branch — they belong to the URL parser below.
  if (!/^(?:https?|ssh|git):/i.test(u)) {
    // SCP-style cannot sensibly represent IPv6 hosts or ports — reject
    // inputs whose host portion starts with `[` or contains a second `:`
    // in the path (which would indicate an embedded port that would then
    // be interpolated into a REST URL).
    if (u.startsWith('[')) return null;
    const scp = u.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (scp) {
      const host = scp[1];
      const path = scp[2].replace(/^\/+/, '');
      // Reject when the "path" contains a colon — that indicates a
      // non-standard `user@host:port:path` form which would silently
      // misroute to the wrong REST API path.
      if (path.includes(':')) return null;
      return { host, path };
    }
  }

  // URL form: https://host/path, ssh://git@host:port/path, git://host/path.
  try {
    const parsed = new URL(u);
    return { host: parsed.hostname, path: parsed.pathname.replace(/^\/+/, '') };
  } catch {
    return null;
  }
}

async function extractOwnerRepo() {
  const remoteUrl = (await tryGitStdout(['remote', 'get-url', 'origin'])) || '';
  const parts = parseGitRemote(remoteUrl);
  if (!parts) return '';
  const segments = parts.path.split('/').filter(Boolean);
  if (segments.length < 2) return '';
  // Validate every segment — ownerRepo gets interpolated into the REST URL.
  for (const seg of segments) {
    if (!SAFE_SEGMENT.test(seg)) return '';
  }
  return segments.join('/');
}

// Strip Authorization header values and obvious token fields from a response
// body before we echo it to the user's terminal or logs.
function redactAuth(text) {
  if (!text) return text;
  return String(text)
    .replace(/("?authorization"?\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/(bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(
      /("?(?:token|access_token|api_key|private_token)"?\s*[:=]\s*")[^"]*(")/gi,
      '$1[REDACTED]$2',
    );
}

const PLATFORMS = ['github', 'gitlab', 'bitbucket', 'gitea', 'git_only'];

function isKnownPlatform(p) {
  return PLATFORMS.includes(p);
}

// Default REST base URL per platform (overridable via --base-url for
// self-hosted GitLab/Gitea/Bitbucket Server).
function defaultBaseUrl(platform) {
  switch (platform) {
    case 'github':
      return 'https://api.github.com';
    case 'gitlab':
      return 'https://gitlab.com/api/v4';
    case 'bitbucket':
      return 'https://api.bitbucket.org/2.0';
    case 'gitea':
      return null; // Gitea is always self-hosted; caller must pass --base-url.
    default:
      return null;
  }
}

// Authorization header per platform when using the REST fallback path.
// Returns null when the requisite token isn't set so the caller can choose
// to skip the API path with a clear "no credentials" message.
function authHeader(platform) {
  switch (platform) {
    case 'github':
      return process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : null;
    case 'gitlab':
      return process.env.GITLAB_TOKEN ? { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN } : null;
    case 'bitbucket':
      return process.env.BITBUCKET_TOKEN
        ? { Authorization: `Bearer ${process.env.BITBUCKET_TOKEN}` }
        : null;
    case 'gitea':
      return process.env.GITEA_TOKEN ? { Authorization: `token ${process.env.GITEA_TOKEN}` } : null;
    default:
      return null;
  }
}

module.exports = {
  SAFE_SEGMENT,
  PLATFORMS,
  hasCli,
  parseGitRemote,
  extractOwnerRepo,
  redactAuth,
  isKnownPlatform,
  defaultBaseUrl,
  authHeader,
};
