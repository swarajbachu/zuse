#!/usr/bin/env bash
set -euo pipefail

status_dir=/var/lib/zuse/project-build
cache_root=/home/repos
manifest="$status_dir/repositories.jsonl"
phase=initializing

mark_failed() {
	local code="$1"
	trap - ERR
	printf 'Build failed during %s (exit %s).\n' "$phase" "$code" >&2
	rm -f "$status_dir/ready"
	printf '%s\n' "$phase" >"$status_dir/failure-phase"
	touch "$status_dir/failed"
	exit "$code"
}

fail() {
	local code=$?
	mark_failed "$code"
}

parse_repository_record() {
	local record="$1"
	local -a fields=()
	mapfile -t fields < <(
		jq -er '
			if type == "object" and
				(.projectId | type == "string") and
				(.repositoryUrl | type == "string") and
				(.defaultBranch | type == "string") and
				(.visibility | type == "string") and
				((.tokenFile == null) or (.tokenFile | type == "string")) and
				(.workspacePath | type == "string")
			then
				.projectId,
				.repositoryUrl,
				.defaultBranch,
				.visibility,
				(.tokenFile // ""),
				.workspacePath
			else
				error("invalid repository manifest record")
			end
		' <<<"$record"
	)
	[[ ${#fields[@]} -eq 6 ]] || return 64
	cache_id="${fields[0]}"
	repository_url="${fields[1]}"
	default_branch="${fields[2]}"
	visibility="${fields[3]}"
	token_file="${fields[4]}"
	workspace_path="${fields[5]}"
}

main() {
	mkdir -p "$status_dir"
	rm -f "$status_dir/ready" "$status_dir/failed" "$status_dir/failure-phase"
	trap fail ERR

	phase=validating-input
	[[ -s "$manifest" ]] || mark_failed 64

	phase=syncing-repository
	mkdir -p "$cache_root"
	export GIT_TERMINAL_PROMPT=0
	while IFS= read -r repository_record; do
		parse_repository_record "$repository_record" || mark_failed 64
		[[ "$cache_id" =~ ^project_[A-Za-z0-9_-]+$ ]] || mark_failed 64
		case "$repository_url" in
			https://*/*/*.git) ;;
			*) mark_failed 64 ;;
		esac
		[[ "$default_branch" =~ ^[A-Za-z0-9._/-]+$ ]] || mark_failed 64
		[[ "$visibility" == "public" || "$visibility" == "private" ]] || mark_failed 64
		[[ "$workspace_path" =~ ^/home/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || mark_failed 64
		if [[ "$visibility" == "private" && ( -z "$token_file" || ! -f "$token_file" ) ]]; then
			printf 'This private repository is not granted to the Zuse GitHub App. Update the App repository selection, then retry.\n' >&2
			mark_failed 67
		fi
		if [[ -n "$token_file" && -f "$token_file" ]]; then
			export GIT_ASKPASS=/usr/local/bin/zuse-git-askpass
			export ZUSE_GIT_TOKEN_FILE="$token_file"
		else
			unset GIT_ASKPASS ZUSE_GIT_TOKEN_FILE
		fi
		if [[ -d "$workspace_path/.git" ]]; then
			git -C "$workspace_path" remote set-url origin "$repository_url"
			git -C "$workspace_path" fetch --prune --tags origin '+refs/heads/*:refs/remotes/origin/*'
		else
			rm -rf "$workspace_path"
			mkdir -p "$(dirname "$workspace_path")"
			git clone --no-checkout "$repository_url" "$workspace_path"
		fi
		git -C "$workspace_path" checkout --force -B "$default_branch" "origin/$default_branch"
		git -C "$workspace_path" clean -ffd
		touch "$workspace_path"
	done <"$manifest"

# One account image must contain every selected repository. Never silently
# evict a checkout; fail the explicit image build and let the UI explain why.
	phase=validating-image-size
	cache_limit="${ZUSE_REPOSITORY_CACHE_MAX_BYTES:-8589934592}"
	cache_size="$(du -sk "$cache_root" | awk '{print $1 * 1024}')"
	(( cache_size <= cache_limit )) || mark_failed 72
	find "$cache_root" -mindepth 2 -maxdepth 2 -type d -printf '%P\t%k\n' \
		| sort >"$status_dir/cache-manifest.tsv"

# Repository-controlled setup must never run while the account Git credential
# exists. The token is used only by Git for the trusted github.com clone above.
	phase=cleaning-credentials
	rm -f /run/zuse-secrets/github-installation-*
	unset GIT_ASKPASS ZUSE_GIT_TOKEN_FILE

# GitHub and runtime identity are never baked in. Broker-capable images retain
# provider configuration, skills, and MCP settings, while reusable agent login
# state remains solely in the account authority.
	phase=sanitizing-snapshot
	rm -rf /home/zuse/.config/gh /home/zuse/.zuse-data /home/zuse/.cache/zuse \
		/tmp/zuse-* 2>/dev/null || true
# E2B may preserve the runtime secrets mount itself. An empty mount is safe to
# snapshot; any file below it is not.
	if [[ -d /run/zuse-secrets ]] && find /run/zuse-secrets -type f -print -quit | grep -q .; then
		mark_failed 73
	fi
	rm -rf /home/zuse/.zuse/cloud-auth/operations /home/zuse/.zuse/cloud-auth/status
	rm -f /home/zuse/.zuse/cloud-auth/private.pem \
		/home/zuse/.zuse/cloud-auth/public.jwk.json /home/zuse/.zuse/cloud-auth/key-id
	if [[ "${ZUSE_CODEX_AUTH_DELIVERY_VERSION:-0}" == "1" ]]; then
		rm -f /home/zuse/.codex/auth.json
	fi
	if [[ "${ZUSE_PROVIDER_AUTH_DELIVERY_VERSION:-0}" == "1" ]]; then
		rm -f /home/zuse/.codex/auth.json /home/zuse/.grok/auth.json \
			/home/zuse/.zuse-image/provider-secrets.json
		rm -rf /home/zuse/.zuse/cloud-auth
	fi
	find /home/zuse -type f \( \
		-name '.env' -o -name '.env.local' -o -name '.env.*.local' -o \
		-name 'credentials.json' \
	\) -delete
	rm -f /home/zuse/.netrc /home/zuse/.git-credentials /home/zuse/.npmrc \
		/home/zuse/.pypirc
	commit_manifest="$status_dir/repository-commits.tsv"
	: >"$commit_manifest"
	while IFS= read -r repository_record; do
		parse_repository_record "$repository_record" || mark_failed 64
		source_commit="$(git -C "$workspace_path" rev-parse "origin/$default_branch")"
		if git -C "$workspace_path" ls-tree -r --name-only "$source_commit" | grep -Ev '(^|/)\.env\.(example|sample|template)$' | grep -Eq '(^|/)\.env($|\.)'; then
			mark_failed 71
		fi
		git -C "$workspace_path" config --unset-all http.https://github.com/.extraheader 2>/dev/null || true
		printf '%s\t%s\t%s\t%s\n' "$cache_id" "$default_branch" "$source_commit" "$workspace_path" >>"$commit_manifest"
	done <"$manifest"
	find /home/zuse -type f -name '*history' -delete
	if pgrep -u zuse -f '(gh auth|claude|codex|grok)' >/dev/null 2>&1; then
		mark_failed 70
	fi
	phase=finalizing
	mkdir -p /var/lib/zuse/account-image
	node --input-type=module -e '
  import { existsSync, readFileSync, writeFileSync } from "node:fs";
  const rows = readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const [projectId, defaultBranch, sourceCommit, workspacePath] = line.split("\t");
    return { projectId, defaultBranch, sourceCommit, workspacePath };
  });
  const codexAuthDeliveryVersion = process.env.ZUSE_CODEX_AUTH_DELIVERY_VERSION === "1" ? 1 : undefined;
  const providerAuthDeliveryVersion = process.env.ZUSE_PROVIDER_AUTH_DELIVERY_VERSION === "1" ? 1 : undefined;
  const providerStatus = process.env.ZUSE_PROVIDER_STATUS_JSON === undefined
    ? null
    : JSON.parse(process.env.ZUSE_PROVIDER_STATUS_JSON);
  const providers = Array.isArray(providerStatus)
    ? providerStatus
    : ["claude", "codex", "cursor", "grok"].map((providerId) => ({
        providerId,
        state: existsSync(`/home/zuse/.zuse/cloud-auth/providers/${providerId}.json`) ||
          (providerId === "codex" && codexAuthDeliveryVersion === undefined && existsSync("/home/zuse/.codex/auth.json")) ||
          (providerId === "grok" && providerAuthDeliveryVersion === undefined && existsSync("/home/zuse/.grok/auth.json"))
          ? "connected"
          : "disconnected",
      }));
  writeFileSync(process.argv[2], JSON.stringify({
    schemaVersion: providerAuthDeliveryVersion === 1 ? 3 : codexAuthDeliveryVersion === 1 ? 2 : 1,
    runtimeVersion: process.env.ZUSE_TEMPLATE_VERSION,
    configurationDigest: process.env.ZUSE_CONFIGURATION_DIGEST,
    repositories: rows,
    providers,
    ...(codexAuthDeliveryVersion === undefined ? {} : { codexAuthDeliveryVersion }),
    ...(providerAuthDeliveryVersion === undefined ? {} : { providerAuthDeliveryVersion }),
  }), { mode: 0o600 });
' "$commit_manifest" /var/lib/zuse/account-image/manifest.json
# Authority bookkeeping is not runtime authentication. Native provider homes
# and the one-shot image secret store above are the only state promoted.
	rm -rf /home/zuse/.zuse/cloud-auth
	sha256sum "$manifest" | cut -d' ' -f1 >"$status_dir/source-commit"
	printf '%s\n' "${ZUSE_TEMPLATE_VERSION:?}" >"$status_dir/template-version"
	printf '%s\n' "${ZUSE_CONFIGURATION_DIGEST:?}" >"$status_dir/configuration-digest"
	touch "$status_dir/ready"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	main "$@"
fi
