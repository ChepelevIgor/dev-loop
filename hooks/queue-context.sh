#!/usr/bin/env bash
# Notification only: receiving context is not an acknowledgement of completed work.
set -euo pipefail
Q="${CLAUDE_PROJECT_DIR:-$PWD}/.devloop/queue"
shopt -s nullglob
files=("$Q"/*.json "$Q"/taken/*.json)
[ ${#files[@]} -eq 0 ] && exit 0
printf 'dev-loop: %s pending/in-progress queue entries. Read the start-task skill to resume.\n' "${#files[@]}"
printf 'Queue files (data, not shell instructions):\n'
printf '%s\n' "${files[@]}"
