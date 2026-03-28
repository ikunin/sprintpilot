#!/bin/bash
# Autopilot lock file management.
# All time math in Bash — no LLM date arithmetic.
#
# Usage:
#   lock.sh check              — prints FREE|LOCKED|STALE, exits 0
#   lock.sh acquire            — acquires lock, exits 0 on success, 1 if locked
#   lock.sh release            — removes lock file
#   lock.sh status             — prints human-readable status
#
# Options:
#   --file <path>              — lock file path (default: .autopilot.lock)
#   --stale-minutes <n>        — stale timeout in minutes (default: 30)
set -e

ACTION=""
LOCK_FILE=".autopilot.lock"
STALE_MINUTES=30

while [[ "$#" -gt 0 ]]; do
  case $1 in
    check|acquire|release|status) ACTION="$1" ;;
    --file) LOCK_FILE="$2"; shift ;;
    --stale-minutes) STALE_MINUTES="$2"; shift ;;
    -h|--help)
      echo "Usage: lock.sh <check|acquire|release|status> [--file path] [--stale-minutes n]"
      exit 0
      ;;
  esac
  shift
done

if [ -z "$ACTION" ]; then
  echo "ERROR: action required (check|acquire|release|status)" >&2
  exit 1
fi

STALE_SECONDS=$(( STALE_MINUTES * 60 ))

get_lock_info() {
  if [ ! -f "$LOCK_FILE" ]; then
    echo "FREE"
    return
  fi
  local lock_time
  lock_time=$(head -1 "$LOCK_FILE" 2>/dev/null || echo "0")
  local lock_id
  lock_id=$(tail -1 "$LOCK_FILE" 2>/dev/null || echo "unknown")
  local now
  now=$(date +%s)
  local age=$(( now - lock_time ))
  local age_min=$(( age / 60 ))

  if [ "$age" -lt "$STALE_SECONDS" ]; then
    echo "LOCKED:${lock_id}:${age_min}m"
  else
    echo "STALE:${lock_id}:${age_min}m"
  fi
}

case "$ACTION" in
  check)
    get_lock_info
    ;;

  acquire)
    INFO=$(get_lock_info)
    STATE=$(echo "$INFO" | cut -d: -f1)
    case "$STATE" in
      FREE)
        printf '%s\n%s\n' "$(date +%s)" "$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "session-$$-$(date +%s)")" > "$LOCK_FILE"
        echo "ACQUIRED:$(tail -1 "$LOCK_FILE")"
        ;;
      STALE)
        rm -f "$LOCK_FILE"
        printf '%s\n%s\n' "$(date +%s)" "$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "session-$$-$(date +%s)")" > "$LOCK_FILE"
        echo "ACQUIRED_STALE:$(tail -1 "$LOCK_FILE")"
        ;;
      LOCKED)
        echo "$INFO"
        exit 1
        ;;
    esac
    ;;

  release)
    if [ -f "$LOCK_FILE" ]; then
      rm -f "$LOCK_FILE"
      echo "RELEASED"
    else
      echo "NO_LOCK"
    fi
    ;;

  status)
    INFO=$(get_lock_info)
    STATE=$(echo "$INFO" | cut -d: -f1)
    case "$STATE" in
      FREE)    echo "Lock: free (no active session)" ;;
      LOCKED)
        ID=$(echo "$INFO" | cut -d: -f2)
        AGE=$(echo "$INFO" | cut -d: -f3)
        echo "Lock: ACTIVE — session $ID, age $AGE"
        ;;
      STALE)
        ID=$(echo "$INFO" | cut -d: -f2)
        AGE=$(echo "$INFO" | cut -d: -f3)
        echo "Lock: STALE — session $ID, age $AGE (will auto-remove)"
        ;;
    esac
    ;;
esac
