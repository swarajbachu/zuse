#!/usr/bin/env bash
set -euo pipefail

required=(ZUSE_MACHINE_ID ZUSE_RELAY_URL ZUSE_RELAY_ISSUER ZUSE_ENROLLMENT_TOKEN)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required sandbox environment variable: $name" >&2
    exit 64
  fi
done

exec 9>/tmp/zuse-entrypoint.lock
if ! flock -n 9; then
  # Reconciliation may repeat a process-start request after a partial failure.
  # The running process owns this lock, so a second server must not be created.
  exit 0
fi

report_boot_status() {
  local phase="$1"
  local status_code="${2:-}"
  local payload
  if [[ -n "$status_code" ]]; then
    payload="{\"phase\":\"$phase\",\"statusCode\":\"$status_code\"}"
  else
    payload="{\"phase\":\"$phase\"}"
  fi
  curl --max-time 10 --connect-timeout 3 --fail --silent --show-error \
    -X POST \
    -H "authorization: Bearer $ZUSE_ENROLLMENT_TOKEN" \
    -H "content-type: application/json" \
    --data "$payload" \
    "$ZUSE_RELAY_URL/v1/machines/$ZUSE_MACHINE_ID/boot-status" \
    >/dev/null || true
}

bootstrap_failed() {
  local exit_code="$?"
  trap - EXIT
  if [[ "$exit_code" -ne 0 ]]; then
    report_boot_status failed bootstrap-failed
  fi
  exit "$exit_code"
}

report_ready_phases() {
  for _ in $(seq 1 60); do
    if curl --max-time 2 --connect-timeout 1 --fail --silent \
      http://127.0.0.1:47837/healthz >/dev/null; then
      report_boot_status zuse-started
      report_boot_status account-setup-available
      return 0
    fi
    sleep 1
  done
  return 1
}

trap bootstrap_failed EXIT
report_boot_status bootstrap-started
report_boot_status runtime-installed
report_boot_status developer-tools-installed

export ZUSE_HOST=0.0.0.0
export ZUSE_PORT=47837
export ZUSE_AUTH_POLICY=protected
export ZUSE_ENABLE_PAIRING=0
export ZUSE_MACHINE_RUNTIME_ROLE=cloud-environment
export ZUSE_SERVER_READY_STDOUT=1
export ZUSE_USER_DATA=/home/zuse/.zuse-data

while true; do
	report_ready_phases &
	readiness_pid="$!"
	if zuse serve --foreground; then
		echo "Zuse server exited; restarting" >&2
	else
		report_boot_status failed bootstrap-failed
		echo "Zuse server crashed; restarting" >&2
	fi
	kill "$readiness_pid" 2>/dev/null || true
	wait "$readiness_pid" 2>/dev/null || true
	sleep 2
done
