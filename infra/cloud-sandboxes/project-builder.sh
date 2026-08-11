#!/usr/bin/env bash
set -euo pipefail

status_dir=/var/lib/zuse/project-build
cache_root=/var/cache/zuse/repositories
cache_id="${ZUSE_PROJECT_CACHE_ID:?}"
mirror="$cache_root/$cache_id.git"
mkdir -p "$status_dir"
rm -f "$status_dir/ready" "$status_dir/failed"

fail() {
  trap - ERR
  rm -f "$status_dir/ready"
  touch "$status_dir/failed"
  exit 1
}
trap fail ERR

case "${ZUSE_REPOSITORY_URL:-}" in
  https://*/*/*.git) ;;
  *) exit 64 ;;
esac

mkdir -p "$cache_root"
export GIT_TERMINAL_PROMPT=0
if [[ -f /run/zuse-secrets/github-token ]]; then
  export GIT_ASKPASS=/usr/local/bin/zuse-git-askpass
  export ZUSE_GIT_TOKEN_FILE=/run/zuse-secrets/github-token
fi
if [[ -d "$mirror" ]]; then
  git -C "$mirror" remote set-url origin "$ZUSE_REPOSITORY_URL"
  git -C "$mirror" fetch --prune --tags origin '+refs/heads/*:refs/heads/*'
else
  git clone --mirror "$ZUSE_REPOSITORY_URL" "$mirror"
fi
source_commit="$(git -C "$mirror" rev-parse "refs/heads/${ZUSE_DEFAULT_BRANCH:?}")"
touch "$mirror"

# Keep the shared account cache bounded. Mirrors are ordered by their last
# refresh time; the mirror being updated is never selected for eviction.
cache_limit="${ZUSE_REPOSITORY_CACHE_MAX_BYTES:-8589934592}"
cache_size="$(du -sk "$cache_root" | awk '{print $1 * 1024}')"
while (( cache_size > cache_limit )); do
  eviction_candidate="$(find "$cache_root" -mindepth 1 -maxdepth 1 -type d ! -path "$mirror" -print0 \
    | xargs -0 -r stat -c '%Y %n' \
    | sort -n \
    | head -n 1 \
    | cut -d' ' -f2-)"
  [[ -n "$eviction_candidate" ]] || break
  rm -rf -- "$eviction_candidate"
  cache_size="$(du -sk "$cache_root" | awk '{print $1 * 1024}')"
done
find "$cache_root" -mindepth 1 -maxdepth 1 -type d -printf '%f\t%k\n' \
  | sort >"$status_dir/cache-manifest.tsv"

# Repository-controlled setup must never run while the account Git credential
# exists. The token is used only by Git for the trusted github.com clone above.
rm -f /run/zuse-secrets/github-token
unset GIT_ASKPASS ZUSE_GIT_TOKEN_FILE

# A prepared build is reusable. Strip every identity and credential surface
# before the relay is allowed to snapshot it.
rm -rf /home/zuse/.config/gh /home/zuse/.claude /home/zuse/.codex \
  /home/zuse/.zuse-data /home/zuse/.cache/zuse /tmp/zuse-* \
  /run/zuse-secrets || true
find /home/zuse -type f \( \
  -name '.env' -o -name '.env.local' -o -name '.env.*.local' -o \
  -name 'credentials.json' -o -name 'auth.json' \
\) -delete
rm -f /home/zuse/.netrc /home/zuse/.git-credentials /home/zuse/.npmrc \
  /home/zuse/.pypirc
if git -C "$mirror" ls-tree -r --name-only "$source_commit" | grep -Ev '(^|/)\.env\.(example|sample|template)$' | grep -Eq '(^|/)\.env($|\.)'; then
  exit 71
fi
find /home/zuse -type f -name '*history' -delete
git -C "$mirror" config --unset-all http.https://github.com/.extraheader 2>/dev/null || true
git -C "$mirror" remote set-url origin "$ZUSE_REPOSITORY_URL"
if pgrep -u zuse -f '(gh auth|claude|codex)' >/dev/null 2>&1; then
  exit 70
fi
rm -rf /home/zuse/workspace
printf '%s\n' "$source_commit" >"$status_dir/source-commit"
printf '%s\n' "${ZUSE_TEMPLATE_VERSION:?}" >"$status_dir/template-version"
printf '%s\n' "${ZUSE_CONFIGURATION_DIGEST:?}" >"$status_dir/configuration-digest"
touch "$status_dir/ready"
