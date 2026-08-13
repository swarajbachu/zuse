#!/usr/bin/env bash
set -euo pipefail

mode="${1:-verify}"
status_dir=/var/lib/zuse/workspace-restore
archive_dir=/var/lib/zuse/workspace-archive
bundle="$archive_dir/recovery.tar.gz"
checksum_file="$archive_dir/recovery.tar.gz.sha256"
staging="$status_dir/staging"
mkdir -p "$status_dir"
rm -f "$status_dir/ready" "$status_dir/failed" "$status_dir/phase" \
	"$status_dir/error-code" "$status_dir/diagnostic.log"
rm -rf "$staging"
phase=initializing
set_phase() { phase="$1"; printf '%s\n' "$phase" > "$status_dir/phase"; }
fail_restore() {
	# Promotion spans the workspace and data directories. If either rename fails,
	# restore the old pair before exposing a failed marker to the reconciler.
	if [[ -d /home/zuse/workspace.restore-previous ]]; then
		rm -rf /home/zuse/workspace
		mv /home/zuse/workspace.restore-previous /home/zuse/workspace
	fi
	if [[ -d /home/zuse/.zuse-data.restore-previous ]]; then
		rm -rf /home/zuse/.zuse-data
		mv /home/zuse/.zuse-data.restore-previous /home/zuse/.zuse-data
	fi
	printf 'restore-%s-failed\n' "$phase" > "$status_dir/error-code"
	touch "$status_dir/failed"
}
trap fail_restore ERR
: > "$status_dir/diagnostic.log"

set_phase bundle-validation
test -f "$bundle"
test -f "$checksum_file"
(cd "$archive_dir" && sha256sum -c recovery.tar.gz.sha256) \
	>> "$status_dir/diagnostic.log" 2>&1
tar -tzf "$bundle" >/dev/null
if tar -tzf "$bundle" | awk '
	/^\// { bad=1 }
	/(^|\/)\.\.($|\/)/ { bad=1 }
	! /^(workspace|\.zuse-data|archive)(\/|$)/ { bad=1 }
	END { exit bad ? 0 : 1 }
'; then
	exit 70
fi
if tar -tzf "$bundle" | grep -Eq '(^|/)(secrets|credentials\.json)(/|$)'; then
	exit 71
fi

set_phase staging
mkdir -p "$staging"
tar -xzf "$bundle" -C "$staging"
manifest="$staging/archive/manifest.json"
database="$staging/archive/zuse.sqlite"
test -f "$manifest"
test -f "$database"
jq -e '
	.manifestVersion == 1 and
	(.schemaVersion | type == "number") and
	(.streamEpoch | type == "string" and length > 0) and
	(.databaseSha256 | test("^[a-f0-9]{64}$")) and
	(.databaseSizeBytes | type == "number" and . > 0) and
	(.sourceGeneration | type == "number" and . >= 0) and
	(.sourceGatewayEpoch | type == "number" and . >= 0) and
	(.sessionHeads | type == "array")
' "$manifest" >/dev/null

set_phase database-validation
expected_database_checksum="$(jq -r '.databaseSha256' "$manifest")"
actual_database_checksum="$(sha256sum "$database" | awk '{print $1}')"
test "$expected_database_checksum" = "$actual_database_checksum"
expected_database_size="$(jq -r '.databaseSizeBytes' "$manifest")"
actual_database_size="$(stat -c '%s' "$database")"
test "$expected_database_size" = "$actual_database_size"
integrity="$(sqlite3 "$database" 'PRAGMA integrity_check;')"
test "$integrity" = ok
manifest_schema="$(jq -r '.schemaVersion' "$manifest")"
database_schema="$(sqlite3 "$database" 'PRAGMA user_version;')"
test "$manifest_schema" = "$database_schema"
jq -e 'all(.sessionHeads[]; (.streamId | type == "string") and (.headVersion | type == "number"))' \
	"$manifest" >/dev/null
sqlite3 -json "$database" \
	"SELECT stream_id AS streamId, MAX(stream_version) AS headVersion FROM events WHERE stream_kind='session' GROUP BY stream_id ORDER BY stream_id;" \
	> "$staging/database-session-heads.json"
jq -S '.sessionHeads' "$manifest" > "$staging/manifest-session-heads.json"
jq -S '.' "$staging/database-session-heads.json" > "$staging/actual-session-heads.json"
cmp -s "$staging/manifest-session-heads.json" "$staging/actual-session-heads.json"

if [[ "$mode" == verify ]]; then
	rm -rf "$staging"
	set_phase complete
	touch "$status_dir/ready"
	exit 0
fi
if [[ "$mode" != promote ]]; then
	exit 64
fi

set_phase promotion
test -d "$staging/workspace"
test -d "$staging/.zuse-data"
install -m 0600 "$database" "$staging/.zuse-data/zuse.sqlite"
rm -f "$staging/.zuse-data/zuse.sqlite-wal" "$staging/.zuse-data/zuse.sqlite-shm"
stream_epoch="${ZUSE_RESTORE_STREAM_EPOCH:?missing restore stream epoch}"
[[ "$stream_epoch" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
sqlite3 "$staging/.zuse-data/zuse.sqlite" \
	"INSERT INTO app_state(key,value) VALUES('session_stream_epoch', '$stream_epoch') ON CONFLICT(key) DO UPDATE SET value=excluded.value;"
rm -rf /home/zuse/workspace.restore-previous /home/zuse/.zuse-data.restore-previous
mv /home/zuse/workspace /home/zuse/workspace.restore-previous
mv /home/zuse/.zuse-data /home/zuse/.zuse-data.restore-previous
mv "$staging/workspace" /home/zuse/workspace
mv "$staging/.zuse-data" /home/zuse/.zuse-data
rm -rf /home/zuse/workspace.restore-previous /home/zuse/.zuse-data.restore-previous "$staging"

set_phase complete
touch "$status_dir/ready"
