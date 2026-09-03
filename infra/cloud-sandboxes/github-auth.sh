#!/usr/bin/env bash
set -euo pipefail

runtime_dir="${ZUSE_USER_DATA:-/home/zuse/.zuse-data}"
token_file="${ZUSE_GITHUB_TOKEN_FILE:-$runtime_dir/github-installation-token}"
token_expiry_file="$runtime_dir/github-installation-token-expires-at"
broker_config_file="$runtime_dir/github-broker.json"
runtime_credential_file="$runtime_dir/cloud-runtime-credential"
gh_binary="${ZUSE_GH_BINARY:-/usr/bin/gh}"
auth_binary="${ZUSE_GITHUB_AUTH_BIN:-/usr/local/bin/zuse-github-auth}"

cached_token_valid() {
	[[ -s "$token_file" ]] || return 1
	[[ -n "${ZUSE_GITHUB_TOKEN_FILE:-}" ]] && return 0
	[[ -s "$token_expiry_file" ]] || return 1
	expires_at=$(<"$token_expiry_file")
	[[ "$expires_at" =~ ^[0-9]+$ ]] || return 1
	(( expires_at > $(date +%s%3N) + 300000 ))
}

refresh_token() {
	[[ -s "$broker_config_file" && -s "$runtime_credential_file" ]] || {
		printf '%s\n' 'GitHub access is not ready in this cloud workspace.' >&2
		return 1
	}
	endpoint=$(jq -er '.credentialUrl' "$broker_config_file")
	runtime_credential=$(<"$runtime_credential_file")
	response=$(curl --fail --silent --show-error --max-time 15 \
		-X POST -H "Authorization: Bearer $runtime_credential" "$endpoint") || return 1
	token=$(jq -er '.token' <<<"$response")
	expires_at=$(jq -er '.expiresAtMs' <<<"$response")
	[[ "$expires_at" =~ ^[0-9]+$ && -n "$token" ]] || return 1
	umask 077
	printf '%s\n' "$token" >"$token_file.next"
	printf '%s\n' "$expires_at" >"$token_expiry_file.next"
	mv "$token_file.next" "$token_file"
	mv "$token_expiry_file.next" "$token_expiry_file"
}

ensure_token() {
	cached_token_valid && return
	mkdir -p "$runtime_dir"
	chmod 700 "$runtime_dir"
	exec 9>"$runtime_dir/github-auth.lock"
	flock 9
	cached_token_valid && return
	if refresh_token; then return; fi
	# A refresh outage must not discard a still-valid cached token.
	if [[ -s "$token_file" && -s "$token_expiry_file" ]]; then
		expires_at=$(<"$token_expiry_file")
		if [[ "$expires_at" =~ ^[0-9]+$ ]] &&
			(( expires_at > $(date +%s%3N) )); then
			return
		fi
	fi
	printf '%s\n' 'Could not obtain GitHub access for this cloud workspace.' >&2
	return 1
}

read_token() {
	ensure_token || return 1
	cat "$token_file"
}

# The image shadows the packaged gh binary. Each invocation resolves a current
# installation token, so shells never retain an expired credential.
if [[ "$(basename "$0")" == "gh" ]]; then
	GH_TOKEN=$(read_token) || exit 1
	export GH_TOKEN
	exec "$gh_binary" "$@"
fi

case "${1:-}" in
	install)
		git config --global credential.https://github.com.username x-access-token
		git config --global credential.https://github.com.helper \
			"$auth_binary credential"
		;;
	credential)
		[[ "${2:-}" == "get" ]] || exit 0
		protocol=
		host=
		while IFS='=' read -r key value; do
			case "$key" in
				protocol) protocol="$value" ;;
				host) host="$value" ;;
			esac
		done
		[[ "$protocol" == "https" && "$host" == "github.com" ]] || exit 0
		password=$(read_token) || exit 1
		printf 'username=%s\n' 'x-access-token'
		printf 'password=%s\n' "$password"
		;;
	*)
		printf '%s\n' 'Usage: zuse-github-auth install|credential <get|store|erase>' >&2
		exit 64
		;;
esac
