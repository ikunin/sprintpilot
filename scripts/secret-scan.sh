#!/usr/bin/env bash
# Local secret-leak gate. Runs gitleaks against the commits being pushed
# (range-aware) so a credential never reaches the remote. Wired into
# .githooks/pre-push; also runnable standalone (scans HEAD vs upstream, or the
# working tree when there is no upstream).
#
# Why pre-PUSH and not just CI: for secrets, CI is too late — by the time CI
# runs, the secret is already on the remote and must be rotated. This hook is
# the last line of defence on the developer's machine.
#
# Fail-closed: if gitleaks is not installed the push is BLOCKED with install
# instructions, because a silently-skipped secret scan is worse than a slow
# one. Set SECRET_SCAN_SOFT=1 to downgrade a missing tool to a warning.
#
# Reads the standard pre-push stdin when present:
#   <local-ref> <local-sha> <remote-ref> <remote-sha>   (one line per ref)
set -euo pipefail

ZERO='0000000000000000000000000000000000000000'
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONFIG_ARG=()
[ -f "$ROOT/.gitleaks.toml" ] && CONFIG_ARG=(--config "$ROOT/.gitleaks.toml")

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "ERROR: gitleaks not installed — secret scan cannot run." >&2
  echo "  macOS:  brew install gitleaks" >&2
  echo "  Linux:  see https://github.com/gitleaks/gitleaks#installing" >&2
  echo "  Go:     go install github.com/gitleaks/gitleaks/v8@latest" >&2
  if [ "${SECRET_SCAN_SOFT:-0}" = "1" ]; then
    echo "SECRET_SCAN_SOFT=1 set — skipping secret scan (NOT recommended)." >&2
    exit 0
  fi
  exit 1
fi

# Collect the commit ranges to scan from the pre-push stdin. `read` is skipped
# when stdin is a TTY so a standalone invocation doesn't block.
ranges=()
if [ ! -t 0 ]; then
  while read -r _localref localsha _remoteref remotesha; do
    [ -z "${localsha:-}" ] && continue
    [ "$localsha" = "$ZERO" ] && continue          # branch deletion — nothing to scan
    if [ "${remotesha:-$ZERO}" = "$ZERO" ]; then
      ranges+=("$localsha --not --remotes")        # new branch: commits not on any remote
    else
      ranges+=("$remotesha..$localsha")            # existing branch: only the new commits
    fi
  done || true
fi

run_gitleaks_git() {
  gitleaks git "${CONFIG_ARG[@]}" --no-banner --redact --log-opts="$1" .
}

rc=0
if [ "${#ranges[@]}" -gt 0 ]; then
  echo "secret-scan: gitleaks over pushed commit range(s)…"
  for r in "${ranges[@]}"; do
    run_gitleaks_git "$r" || rc=1
  done
elif up="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
  echo "secret-scan: gitleaks over ${up}..HEAD…"
  run_gitleaks_git "@{u}..HEAD" || rc=1
else
  # No upstream (e.g. brand-new repo/branch). Scan the working tree so an
  # uncommitted secret is still caught before the first push.
  echo "secret-scan: no upstream — gitleaks over the working tree…"
  gitleaks dir "${CONFIG_ARG[@]}" --no-banner --redact . || rc=1
fi

if [ "$rc" -ne 0 ]; then
  echo "" >&2
  echo "✗ secret-scan: gitleaks found a potential secret (redacted above)." >&2
  echo "  - False positive? add an allowlist entry to .gitleaks.toml or an" >&2
  echo "    inline 'gitleaks:allow' comment on the line." >&2
  echo "  - Real secret already committed? remove it AND rotate the credential" >&2
  echo "    (rewriting history alone does not un-leak a pushed secret)." >&2
  exit 1
fi
echo "✓ secret-scan: clean"
