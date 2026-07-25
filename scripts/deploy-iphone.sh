#!/bin/bash
# Deploy a branch to the owner's iPhone over WiFi, driving the Mac via SSH.
# Usage: scripts/deploy-iphone.sh [ref]   (default: current branch's tip)
# Needs: `ssh mac` (key auth), and the keychain password in
# ~/.wingover-deploy.env on the calling box as WINGOVER_MAC_KEYCHAIN_PW=...
# (never committed; repos are public).
set -euo pipefail
REF="${1:-$(git rev-parse --abbrev-ref HEAD)}"
source ~/.wingover-deploy.env
DEVICE="0CBB62FC-1D74-54E2-A1F3-7EDF0514882F" # iPhone 13 mini, WiFi-paired
WT='~/wingover-pr153'                          # detached Mac worktree for agent builds

ssh mac "zsh -ilc '
  set -e
  cd $WT
  git checkout -- . 2>/dev/null || true
  git fetch origin $REF && git checkout FETCH_HEAD
  pnpm install --silent
  # Keychain re-locks between SSH sessions: unlock must share the build shell.
  security unlock-keychain -p \"$WINGOVER_MAC_KEYCHAIN_PW\" login.keychain-db
  ( while sleep 20; do security unlock-keychain -p \"$WINGOVER_MAC_KEYCHAIN_PW\" login.keychain-db; done ) & KA=\$!
  trap \"kill \$KA 2>/dev/null\" EXIT
  pnpm exec tauri ios build --debug
  xcrun devicectl device install app --device $DEVICE src-tauri/gen/apple/build/arm64/Wingover.ipa
  xcrun devicectl device process launch --device $DEVICE app.wingover.wingover || echo \"install OK; launch needs the phone unlocked\"
'"
