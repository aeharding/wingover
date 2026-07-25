#!/bin/bash
# Deploy a commit to the owner's iPhone over WiFi, driving the Mac via SSH.
# Usage: scripts/deploy-iphone.sh [ref]   (default: HEAD, resolved to a sha)
#
# Needs: `ssh mac` (key auth), and the keychain password in
# ~/.wingover-deploy.env on the calling box as WINGOVER_MAC_KEYCHAIN_PW=...
# (never committed; repos are public).
# Overrides: WINGOVER_MAC_WT (Mac worktree path), WINGOVER_DEVICE (UDID).
#
# The default is HEAD as a SHA, not a branch name: agent sessions run in
# detached worktrees that have no branch, and a SHA is exactly the commit
# that was tested here. The Mac fetches that SHA, so a commit that was
# never pushed fails loudly instead of quietly building whatever the Mac
# already had checked out.
#
# The password never reaches a LOCAL command line: it rides on ssh's stdin
# and is read into a remote shell variable. What remains is the remote
# `security -p` argv for the life of each unlock call, accepted knowingly —
# the alternative (an interactive prompt) cannot run unattended.
set -euo pipefail
REF="${1:-$(git rev-parse HEAD)}"
source ~/.wingover-deploy.env
DEVICE="${WINGOVER_DEVICE:-0CBB62FC-1D74-54E2-A1F3-7EDF0514882F}" # iPhone 13 mini, WiFi-paired
WT="${WINGOVER_MAC_WT:-~/wingover-pr153}"                         # detached Mac worktree for agent builds

ssh mac "zsh -ilc '
  set -e
  IFS= read -r PW
  cd $WT
  git checkout -- . 2>/dev/null || true
  git fetch origin \"$REF\" && git checkout FETCH_HEAD
  pnpm install --silent
  # Keychain re-locks between SSH sessions: unlock must share the build shell.
  security unlock-keychain -p \"\$PW\" login.keychain-db
  # The keepalive outlives its trap on a dropped connection or a SIGKILL,
  # so it checks the shell that owns it is still alive rather than relying
  # on being told: no orphan re-unlocking the keychain for hours.
  PARENT=\$\$
  ( while sleep 20; do
      kill -0 \$PARENT 2>/dev/null || exit 0
      security unlock-keychain -p \"\$PW\" login.keychain-db
    done ) & KA=\$!
  trap \"kill \$KA 2>/dev/null\" EXIT
  pnpm exec tauri ios build --debug
  xcrun devicectl device install app --device $DEVICE src-tauri/gen/apple/build/arm64/Wingover.ipa
  xcrun devicectl device process launch --device $DEVICE app.wingover.wingover || echo \"install OK; launch needs the phone unlocked\"
'" <<<"$WINGOVER_MAC_KEYCHAIN_PW"
