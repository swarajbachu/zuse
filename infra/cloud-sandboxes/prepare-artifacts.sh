#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
artifacts_dir="$script_dir/artifacts"

mkdir -p "$artifacts_dir"
cd "$repo_root"

bun run --filter @zusehq/server build:bundle
bun run --filter @zusehq/serve build
npm pack ./apps/server --pack-destination "$artifacts_dir"
npm pack ./packages/serve --pack-destination "$artifacts_dir"
