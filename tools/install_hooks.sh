#!/usr/bin/env bash
# Install this clone's committed Aven-standard ownership hook without replacing
# an existing custom hooksPath. Usage: bash tools/install_hooks.sh from the clone.
# Writes local Git configuration and the hook executable bit; no environment
# variables or network access. Exits nonzero on a conflicting hook path or Git error.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
existing=$(git config --get core.hooksPath || true)
if [[ -n "$existing" && "$existing" != tools/hooks ]]; then
  echo "Refusing to replace core.hooksPath=$existing; integrate the hook manually." >&2
  exit 1
fi
# Preserve a clone-local pre-commit hook rather than silently disabling it.
if [[ -z "$existing" && -f .git/hooks/pre-commit ]]; then
  echo "Existing .git/hooks/pre-commit found; integrate the hook manually." >&2
  exit 1
fi
chmod +x tools/hooks/pre-commit
git config --local core.hooksPath tools/hooks
echo "core.hooksPath -> tools/hooks"
