#!/usr/bin/env bash
# Build installable binaries.
#   ./scripts/build.sh [mac|win|linux|all|dir] [--skip-tests] [--arch x64|arm64|universal]
# Output: apps/desktop/release/<version>/
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-current}"
shift || true
SKIP_TESTS=0
ARCH_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=1 ;;
    --arch) ARCH_ARGS+=("--$2"); shift ;;
    *) echo "Unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

if [[ "$TARGET" == "current" ]]; then
  case "$(uname -s)" in
    Darwin) TARGET=mac ;;
    Linux) TARGET=linux ;;
    MINGW*|MSYS*|CYGWIN*) TARGET=win ;;
  esac
fi

command -v pnpm >/dev/null || { echo "pnpm is required (corepack enable)" >&2; exit 1; }
echo "==> Node $(node -v), pnpm $(pnpm -v), target: $TARGET"
node scripts/clean.mjs
pnpm install --frozen-lockfile
pnpm icons
if [[ $SKIP_TESTS -eq 0 ]]; then
  pnpm turbo run typecheck lint test build
else
  pnpm turbo run typecheck lint build
fi

cd apps/desktop
case "$TARGET" in
  mac) pnpm exec electron-builder --mac ${ARCH_ARGS[@]+"${ARCH_ARGS[@]}"} --publish never ;;
  win) pnpm exec electron-builder --win ${ARCH_ARGS[@]+"${ARCH_ARGS[@]}"} --publish never ;;
  linux) pnpm exec electron-builder --linux ${ARCH_ARGS[@]+"${ARCH_ARGS[@]}"} --publish never ;;
  all) pnpm exec electron-builder --mac --win --linux --publish never ;;
  dir) pnpm exec electron-builder --dir ${ARCH_ARGS[@]+"${ARCH_ARGS[@]}"} --publish never ;;
  *) echo "Unknown target $TARGET (use mac|win|linux|all|dir)" >&2; exit 1 ;;
esac

VERSION=$(node -p "require('./package.json').version")
echo "==> Artifacts in apps/desktop/release/$VERSION:"
ls -1 "release/$VERSION" | grep -Ev '\.(blockmap|yml|yaml)$|unpacked$|builder-' || true
