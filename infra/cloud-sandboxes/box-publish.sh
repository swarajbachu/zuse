#!/usr/bin/env bash
# Publishes the zuse base template for the Box provider as a named snapshot.
# Box has no custom-image API, so the template is built by provisioning a
# fresh box with the shared provision.sh stages plus the Box-specific pieces
# (in-guest quarantine firewall, boot-time port hosting), then freezing it.
#
# Usage: BOX_API_KEY=... box-publish.sh <version>
#   e.g. box-publish.sh 1   →  named snapshot "zuse-base-v1"
#
# Prints the BOX_TEMPLATE_SNAPSHOT / BOX_TEMPLATE_VERSION values to copy into
# the API wrangler configuration.
set -euo pipefail

version="${1:?usage: box-publish.sh <version>}"
api_key="${BOX_API_KEY:?BOX_API_KEY is required}"
api_base="${BOX_API_BASE_URL:-https://ascii.dev/api/box/v1}"
snapshot_name="zuse-base-v$version"
snapshot_wait_attempts="${BOX_SNAPSHOT_WAIT_ATTEMPTS:-360}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
provision_dir=/tmp/zuse-provision

api() {
	local method="$1" path="$2"
	shift 2
	curl -sSf -X "$method" "$api_base$path" \
		-H "authorization: Bearer $api_key" \
		"$@"
}

api_json() {
	local method="$1" path="$2" body="$3"
	api "$method" "$path" -H "content-type: application/json" -d "$body"
}

box_command() {
	local box_id="$1" command="$2" timeout="${3:-600}"
	api_json POST "/boxes/$box_id/commands" \
		"$(jq -n --arg command "$command" --argjson timeout "$timeout" \
			'{command: $command, timeoutSeconds: $timeout}')"
}

# Long installs exceed the 600s synchronous cap: run detached and poll.
box_command_detached() {
	local box_id="$1" command="$2" process_id status
	process_id="$(api_json POST "/boxes/$box_id/commands" \
		"$(jq -n --arg command "$command" '{command: $command, detached: true}')" |
		jq -r '.processId')"
	while true; do
		status="$(api GET "/boxes/$box_id/commands/$process_id?tailBytes=4096")"
		if [ "$(jq -r '.running' <<<"$status")" != "true" ]; then
			if [ "$(jq -r '.exitCode' <<<"$status")" != "0" ]; then
				echo "detached command failed:" >&2
				jq -r '.stderr' <<<"$status" >&2
				exit 1
			fi
			jq -r '.stdout' <<<"$status" | tail -5
			return 0
		fi
		sleep 10
	done
}

upload_file_part() {
	local box_id="$1" source="$2" target="$3" encoded status=0
	# The v1 file API accepts JSON, including base64 for binary artifacts.
	# Keep large runtime tarballs out of shell arguments. A real temporary file
	# is used instead of process substitution because jq reopens --rawfile paths
	# after the producer's file descriptor can already be gone.
	encoded="$(mktemp)"
	base64 <"$source" | tr -d '\n' >"$encoded"
	jq -n --arg path "$target" \
		--rawfile content "$encoded" \
		'{path: $path, content: $content, encoding: "base64"}' |
		curl -sSf -X PUT "$api_base/boxes/$box_id/files" \
			-H "authorization: Bearer $api_key" \
			-H "content-type: application/json" \
			--data-binary @- || status=$?
	rm -f "$encoded"
	return "$status"
}

upload_file() {
	local box_id="$1" source="$2" target="$3" chunk_dir part remote
	local status=0 remote_args=""
	local -a chunks=()
	if [ "$(wc -c <"$source")" -le 4000000 ]; then
		upload_file_part "$box_id" "$source" "$target"
		return
	fi

	# Box rejects large JSON file bodies. Upload bounded binary chunks, then
	# reassemble them through the command channel before provisioning starts.
	chunk_dir="$(mktemp -d)"
	split -b 4000000 "$source" "$chunk_dir/part-"
	for part in "$chunk_dir"/part-*; do
		chunks+=("$part")
	done
	for part in "${chunks[@]}"; do
		remote="$target.zuse-upload-$(basename "$part")"
		upload_file_part "$box_id" "$part" "$remote" || {
			status=$?
			break
		}
		remote_args+=" $(jq -rn --arg value "$remote" '$value | @sh')"
	done
	if [ "$status" -eq 0 ]; then
		box_command "$box_id" \
			"cat$remote_args > $(jq -rn --arg value "$target" '$value | @sh') && rm -f$remote_args" >/dev/null || status=$?
	fi
	for part in "${chunks[@]}"; do
		rm -f "$part"
	done
	rmdir "$chunk_dir"
	return "$status"
}

echo "==> building runtime artifacts"
"$script_dir/prepare-artifacts.sh"

echo "==> creating builder box"
# The Box account environment is inherited on purpose: shared credentials
# configured there become part of the base template so runtimes launch with
# them already present (account-image architecture).
box_id="$(api_json POST /boxes '{"ttlSeconds": 7200}' | jq -r '.box.id')"
echo "    box: $box_id"
trap 'api DELETE "/boxes/$box_id" -H "x-ascii-confirm-delete: '"$box_id"'" >/dev/null || true' EXIT

echo "==> waiting for the box to become usable"
for _ in $(seq 1 60); do
	state="$(api GET "/boxes/$box_id" | jq -r '.box.state')"
	case "$state" in
	ready | idle | running) break ;;
	error)
		echo "box provisioning failed" >&2
		exit 1
		;;
	esac
	sleep 5
done

echo "==> uploading provisioning payload"
box_command "$box_id" "mkdir -p $provision_dir/artifacts $provision_dir/box"
for file in provision.sh project-builder.sh workspace-bootstrap.sh git-askpass.sh github-auth.sh repository-script.ts sshd_config; do
	upload_file "$box_id" "$script_dir/$file" "$provision_dir/$file"
done
for file in "$script_dir"/box/*; do
	upload_file "$box_id" "$file" "$provision_dir/box/$(basename "$file")"
done
for file in "$script_dir"/artifacts/*; do
	upload_file "$box_id" "$file" "$provision_dir/artifacts/$(basename "$file")"
done
box_command "$box_id" "chmod +x $provision_dir/provision.sh $provision_dir/box/install.sh $provision_dir/box/zuse-firewall"

echo "==> installing the template (this takes several minutes)"
box_command_detached "$box_id" "sudo -n ZUSE_PROVISION_DIR=$provision_dir bash $provision_dir/box/install.sh && sudo -n rm -rf $provision_dir"

echo "==> verifying the quarantine barrier"
box_command "$box_id" "sudo -n /usr/local/sbin/zuse-firewall verify-quarantined"

echo "==> saving named snapshot $snapshot_name"
api_json POST /named-snapshots \
	"$(jq -n --arg boxId "$box_id" --arg name "$snapshot_name" '{boxId: $boxId, name: $name}')" >/dev/null
for _ in $(seq 1 "$snapshot_wait_attempts"); do
	status="$(api GET "/named-snapshots/$snapshot_name" | jq -r '.snapshot.status')"
	case "$status" in
	ready) break ;;
	failed)
		echo "named snapshot save failed" >&2
		exit 1
		;;
	esac
	sleep 5
done
[ "$status" = "ready" ] || {
	echo "named snapshot did not become ready in time" >&2
	exit 1
}

echo "==> done. Configure the API with:"
echo "    BOX_TEMPLATE_SNAPSHOT=$snapshot_name"
echo "    BOX_TEMPLATE_VERSION=$version"
