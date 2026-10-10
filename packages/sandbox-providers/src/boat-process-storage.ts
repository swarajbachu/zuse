import { boxProcessStoppedChecks } from "./box-process.ts";
import { WORKSPACE_RUNTIME_PROCESS_SELECTOR } from "./index.ts";
import { rootProcessCommand } from "./process-activation.ts";

/** Run only after Boat's persisted-mount barrier. Never merge ownership roots. */
export const boatProcessStorageScript = (): string =>
	[
		"set -e",
		"install -d -m 0755 -o root -g root /srv/zuse",
		"exec 8>/srv/zuse/.process-storage.lock",
		"flock -x 8",
		"preserve_directory() {",
		'  source="$1"; destination="$2"; owner="$3"; mode="$4"',
		'  [ ! -L "$destination" ] || return 1',
		'  if [ -L "$source" ]; then',
		'    [ "$(readlink -f "$source")" = "$destination" ] || return 1',
		'  elif [ -e "$source" ]; then',
		'    [ -d "$source" ] || return 1',
		// Moving data or lock paths under a live runtime would split ownership.
		// Existing machines migrate on a cold recovery; aliases need no mutation.
		'    if [ -n "$(ls -A "$source")" ]; then',
		...boxProcessStoppedChecks(WORKSPACE_RUNTIME_PROCESS_SELECTOR),
		"    fi",
		'    if [ -d "$destination" ]; then',
		'      if [ -n "$(ls -A "$source")" ]; then',
		'        [ -z "$(ls -A "$destination")" ] || return 1',
		'        rmdir "$destination"',
		'      else rmdir "$source"; fi',
		"    fi",
		'    if [ -d "$source" ]; then',
		// Cross-filesystem mv copies lock inodes; preserve both and fail instead.
		'      [ "$(stat -c %d "$source")" = "$(stat -c %d /srv/zuse)" ] || { [ -z "$(ls -A "$source")" ] && rmdir "$source"; }',
		'      if [ -d "$source" ]; then mv -T "$source" "$destination"; fi',
		"    fi",
		"  fi",
		// Preserve an existing directory's ownership; only a fresh one needs setup.
		'  if [ ! -d "$destination" ]; then install -d -m "$mode" -o "$owner" -g "$owner" "$destination"; fi',
		'  if [ ! -L "$source" ]; then ln -s "$destination" "$source"; fi',
		'  [ "$(readlink -f "$source")" = "$destination" ]',
		"}",
		"preserve_directory /var/lib/zuse-process-activations /srv/zuse/process-activations root 0700",
		"[ -d /var/lib/zuse ] || install -d -m 0755 -o zuse -g zuse /var/lib/zuse",
		"preserve_directory /var/lib/zuse/user-data /srv/zuse/home/.zuse-data zuse 0700",
		"preserve_directory /var/lib/zuse/runtime-update /srv/zuse/runtime-update zuse 0700",
		// Boat already captures /opt (https://docs.boat.dev/snapshots).
		// Keep release paths and any existing aliases intact, independent of
		// whether /opt and /srv happen to share a device on this machine.
		"sync -f /srv/zuse",
	].join("\n");

/** Standalone repair keeps the same lock as full layout reconciliation. */
export const boatProcessStorageCommand = (): string =>
	rootProcessCommand(boatProcessStorageScript());
