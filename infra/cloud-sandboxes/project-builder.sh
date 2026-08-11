#!/usr/bin/env bash
set -euo pipefail

status_dir=/var/lib/zuse/project-build
workspace=/home/zuse/workspace
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

rm -rf "$workspace"
export GIT_TERMINAL_PROMPT=0
if [[ -f /run/zuse-secrets/github-token ]]; then
  export GIT_ASKPASS=/usr/local/bin/zuse-git-askpass
  export ZUSE_GIT_TOKEN_FILE=/run/zuse-secrets/github-token
fi
git clone --no-single-branch "$ZUSE_REPOSITORY_URL" "$workspace"
cd "$workspace"
git checkout "${ZUSE_DEFAULT_BRANCH:?}"
source_commit="$(git rev-parse HEAD)"

# Repository-controlled setup must never run while the account Git credential
# exists. The token is used only by Git for the trusted github.com clone above.
rm -f /run/zuse-secrets/github-token
unset GIT_ASKPASS ZUSE_GIT_TOKEN_FILE

while IFS= read -r -d '' key && IFS= read -r -d '' value; do
  if [[ -z "${!key+x}" ]]; then export "$key=$value"; fi
done < <(bun /usr/local/lib/zuse/repository-script.ts environment)
setup_command="${ZUSE_SETUP_COMMAND:-}"
if [[ -z "$setup_command" ]]; then
  setup_command="$(bun /usr/local/lib/zuse/repository-script.ts setup)"
fi
if [[ -n "$setup_command" ]]; then
  bash -lc "$setup_command"
fi

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
if git ls-files | grep -Ev '(^|/)\.env\.(example|sample|template)$' | grep -Eq '(^|/)\.env($|\.)'; then
  exit 71
fi
find /home/zuse -type f -name '*history' -delete
git config --local --unset-all http.https://github.com/.extraheader 2>/dev/null || true
git remote set-url origin "$ZUSE_REPOSITORY_URL"
if pgrep -u zuse -f '(gh auth|claude|codex)' >/dev/null 2>&1; then
  exit 70
fi
git diff --quiet
git diff --cached --quiet
printf '%s\n' "$source_commit" >"$status_dir/source-commit"
printf '%s\n' "${ZUSE_TEMPLATE_VERSION:?}" >"$status_dir/template-version"
printf '%s\n' "${ZUSE_CONFIGURATION_DIGEST:?}" >"$status_dir/configuration-digest"
touch "$status_dir/ready"
