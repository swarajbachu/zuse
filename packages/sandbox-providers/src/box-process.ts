import type { SandboxProcessInput, SandboxProcessSelector } from "./index.ts";
import {
	processActivationDescription,
	processActivationGuard,
} from "./process-activation.ts";

export { processShellQuote as boxShellQuote } from "./process-activation.ts";

import {
	processShellQuote as boxShellQuote,
	rootProcessCommand,
} from "./process-activation.ts";

const encodeProcessComponent = (value: string): string =>
	Array.from(new TextEncoder().encode(value), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");

const processTagFile = (tag: string): string =>
	`${encodeProcessComponent(tag)}.pid`;

export const boxForkRuntimePreparedCommand = (childId: string): string =>
	`sudo -n test -f ${boxShellQuote(`/var/lib/zuse-fork-preparation/${encodeProcessComponent(childId)}/complete`)}`;

/** Only invoke for a provider-verified, egress-quarantined native fork child. */
export const boxForkRuntimeResetCommand = (
	childId: string,
	user: string,
	selector: SandboxProcessSelector,
): string => {
	const pattern = `zuse-process-*-${encodeProcessComponent(selector.tag)}.service`;
	const patterns = (selector.legacyCommandMarkers ?? [])
		.filter(Boolean)
		.map((marker) => {
			const first = marker[0]?.replace(/[\\\]^]/gu, "\\$&");
			return `[${first}]${marker.slice(1).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`;
		});
	return rootProcessCommand(
		[
			"set -euo pipefail",
			`preparation=${boxShellQuote(`/var/lib/zuse-fork-preparation/${encodeProcessComponent(childId)}`)}`,
			'install -d -m 0700 -o root -g root /var/lib/zuse-fork-preparation "$preparation"',
			"umask 077",
			'exec 8>"$preparation/lock"',
			"flock -x 8",
			// This marker is child-ID-specific; a cloned parent's marker never matches.
			'test ! -f "$preparation/complete" || exit 0',
			"install -d -m 0700 -o root -g root /var/lib/zuse-process-activations",
			`units=(${boxShellQuote(boxProcessUnit(user, selector.tag))})`,
			`listed=$(systemctl list-units --all --plain --no-legend --full ${boxShellQuote(pattern)})`,
			'while read -r unit rest; do [ -z "$unit" ] || units+=("$unit"); done <<< "$listed"',
			"shopt -s nullglob",
			`for directory in /var/lib/zuse-process-activations/${pattern}; do units+=("\${directory##*/}"); done`,
			"declare -A seen=()",
			"owners=()",
			`for unit in "\${units[@]}"; do`,
			`  [[ "$unit" == ${pattern} ]] || exit 1`,
			`  [ -z "\${seen[$unit]:-}" ] || continue`,
			"  seen[$unit]=1",
			'  directory="/var/lib/zuse-process-activations/$unit"',
			'  install -d -m 0700 -o root -g root "$directory"',
			'  exec {guard}>"$directory/lock"',
			'  flock -x "$guard"',
			'  owners+=("$directory/owner")',
			'  state=$(systemctl show --property=LoadState --value "$unit" 2>/dev/null || true)',
			'  case "$state" in loaded) systemctl stop "$unit" ;; not-found) ;; *) exit 1 ;; esac',
			'  state=$(systemctl show --property=LoadState --value "$unit" 2>/dev/null || true)',
			'  case "$state" in not-found) ;; loaded)',
			'    active=$(systemctl show --property=ActiveState --value "$unit")',
			'    case "$active" in inactive|failed) ;; *) exit 1 ;; esac',
			"    ;; *) exit 1 ;; esac",
			"done",
			`sudo -n -E -H -u ${boxShellQuote(user)} bash -c ${boxShellQuote(boxProcessCleanupScript(selector))}`,
			...patterns.flatMap((pattern) => [
				`pkill -KILL -f -- ${boxShellQuote(pattern)} || [ "$?" = 1 ]`,
				`if pgrep -f -- ${boxShellQuote(pattern)} >/dev/null; then exit 1; else [ "$?" = 1 ]; fi`,
			]),
			// A stopped service is not enough if an unaccounted process still owns a
			// database writer. Inspect descriptor flags, never database contents.
			runtimeDatabaseWriterCheck(),
			// The updater may be a separately dispatched process. Never clear its
			// transaction unless its existing lock is available as well.
			"if [ -d /var/lib/zuse/runtime-update ]; then",
			"  exec 7>/var/lib/zuse/runtime-update/transaction.json.lock",
			"  flock -xn 7",
			"  rm -f -- /var/lib/zuse/runtime-update/transaction.json",
			"  sync -f /var/lib/zuse/runtime-update",
			"fi",
			`rm -f -- "\${owners[@]}"`,
			"sync -f /var/lib/zuse-process-activations",
			`printf '%s\\n' ${boxShellQuote(childId)} > "$preparation/complete.next"`,
			'sync -f "$preparation/complete.next"',
			'mv -f "$preparation/complete.next" "$preparation/complete"',
			'sync -f "$preparation"',
		].join("\n"),
	);
};

/** Fail closed if an unaccounted process still holds a writable runtime DB. */
export const runtimeDatabaseWriterCheck = (): string =>
	`node -e ${boxShellQuote(`const fs=require("node:fs");for(const pid of fs.readdirSync("/proc")){if(!/^\\d+$/.test(pid))continue;let fds;try{fds=fs.readdirSync("/proc/"+pid+"/fd")}catch(e){if(e.code==="ENOENT")continue;throw e}for(const fd of fds){try{const path=fs.readlinkSync("/proc/"+pid+"/fd/"+fd);if(!/(?:^|\\/)zuse\\.sqlite(?:-wal|-shm)?(?: \\(deleted\\))?$/.test(path))continue;const info=fs.readFileSync("/proc/"+pid+"/fdinfo/"+fd,"utf8");const flags=info.match(/^flags:\\s*([0-7]+)/m);if(!flags||(parseInt(flags[1],8)&3)!==0)process.exit(1)}catch(e){if(e.code!=="ENOENT")throw e}}}`)}`;

export const boxProcessStoppedChecks = (
	selector: SandboxProcessSelector,
): string[] => [
	...(selector.legacyCommandMarkers ?? [])
		.filter(Boolean)
		.map(
			(marker) =>
				`if pgrep -f -- ${boxShellQuote(boxProcessMarkerPattern(marker))} >/dev/null; then exit 1; else [ "$?" = 1 ]; fi`,
		),
	...(selector.tag === "zuse-runtime" ? [runtimeDatabaseWriterCheck()] : []),
];

/** Separate users and tags without aliasing punctuation in either value. */
export const boxProcessUnit = (user: string, tag: string): string =>
	`zuse-process-${encodeProcessComponent(user)}-${encodeProcessComponent(tag)}.service`;

export const boxProcessScript = (input: SandboxProcessInput): string =>
	[
		...(input.cwd === undefined
			? ['cd "$HOME"']
			: [`cd ${boxShellQuote(input.cwd)}`]),
		...Object.entries(input.env ?? {}).map(
			([key, value]) => `export ${key}=${boxShellQuote(value)}`,
		),
		`exec ${[input.command, ...(input.args ?? [])].map(boxShellQuote).join(" ")}`,
	].join(" && ");

/** Match an existing process without matching the probe's own literal argv. */
export const boxProcessMarkerPattern = (marker: string): string => {
	const first = marker[0]?.replace(/[\\\]^]/gu, "\\$&");
	const rest = marker.slice(1).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return `[${first}]${rest}`;
};

/** Retire pre-systemd processes, retaining the boot-ID fence against PID reuse. */
export const boxProcessCleanupScript = (
	selector: SandboxProcessSelector,
): string =>
	[
		`pidfile="$HOME/.zuse-processes/${processTagFile(selector.tag)}"`,
		'if [ -f "$pidfile" ]; then read -r boot pid < "$pidfile"; if [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] && [ "$pid" -gt 1 ] 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi; rm -f "$pidfile"; fi',
		...(selector.legacyCommandMarkers ?? [])
			.filter(Boolean)
			.map(
				(marker) =>
					`pkill -KILL -f -- ${boxShellQuote(boxProcessMarkerPattern(marker))} || true`,
			),
		"true",
	].join("; ");

/**
 * Start a transient service only after the caller has authorized this launch.
 * No boot enablement or automatic restart: cloud boot tokens are single-use.
 * systemd owns the entire process tree, including children that call setsid.
 * Its unit is the process identity; no writable home-directory PID file is needed.
 */
export const boxSystemdProcessCommand = (
	input: SandboxProcessInput,
	unit: string,
	selector?: SandboxProcessSelector,
): string => {
	const user = input.user ?? "user";
	const description = processActivationDescription(input.activation);
	const script = [
		...processActivationGuard(input, unit, [
			`state=$(systemctl show --property=LoadState --value ${boxShellQuote(unit)} 2>/dev/null || true)`,
			'case "$state" in loaded|not-found) ;; *) exit 1 ;; esac',
			'if [ "$state" = loaded ]; then',
			`actual_description=$(systemctl show --property=Description --value ${boxShellQuote(unit)})`,
			`active_state=$(systemctl show --property=ActiveState --value ${boxShellQuote(unit)})`,
			`if [ "$actual_description" = ${boxShellQuote(description)} ]; then`,
			'case "$active_state" in active|activating|reloading) exit 0 ;; esac',
			"fi; fi",
		]),
		...(selector === undefined
			? []
			: [
					`state=$(systemctl show --property=LoadState --value ${boxShellQuote(unit)} 2>/dev/null || true)`,
					`case "$state" in loaded) systemctl stop ${boxShellQuote(unit)} ;; not-found) ;; *) exit 1 ;; esac`,
					...(input.activation === undefined
						? []
						: [
								`state=$(systemctl show --property=LoadState --value ${boxShellQuote(unit)} 2>/dev/null || true)`,
								'case "$state" in not-found) ;; loaded)',
								`active_state=$(systemctl show --property=ActiveState --value ${boxShellQuote(unit)})`,
								'case "$active_state" in inactive|failed) ;; *) exit 1 ;; esac',
								";; *) exit 1 ;; esac",
							]),
					`sudo -n -E -H -u ${boxShellQuote(user)} bash -c ${boxShellQuote(boxProcessCleanupScript(selector))}`,
					...boxProcessStoppedChecks(selector),
				]),
		// systemd does not inherit the provider command's account environment.
		// Forward it explicitly, then restore the target user's login identity.
		"environment=()",
		'while IFS= read -r -d "" entry; do case "$entry" in HOME=*|USER=*|LOGNAME=*|SHELL=*|PWD=*|OLDPWD=*|SUDO_*=*|_=*) continue ;; esac; environment+=("--setenv=$entry"); done < <(env -0)',
		`target_home=$(getent passwd ${boxShellQuote(user)} | cut -d: -f6)`,
		'test -n "$target_home"',
		`systemd-run --quiet --collect --service-type=exec --expand-environment=no --description=${boxShellQuote(description)} --unit=${boxShellQuote(unit)} --uid=${boxShellQuote(user)} --property=Restart=no --property=KillMode=control-group --property=TimeoutStopSec=5s "\${environment[@]}" "--setenv=HOME=$target_home" --setenv=${boxShellQuote(`USER=${user}`)} --setenv=${boxShellQuote(`LOGNAME=${user}`)} -- /usr/bin/setsid --wait /bin/bash -c ${boxShellQuote(boxProcessScript(input))}`,
	].join("\n");
	return rootProcessCommand(script);
};

/** One guest observation, only during authorized recovery; never a wake probe. */
export const boxSystemdProcessInspectionCommand = (
	selector: SandboxProcessSelector,
	user: string,
): string =>
	[
		`state=$(systemctl show --property=ActiveState --value ${boxShellQuote(boxProcessUnit(user, selector.tag))}) || { printf unknown; exit 0; }`,
		'case "$state" in active|activating|reloading) printf active; exit 0 ;; inactive|failed) ;; *) printf unknown; exit 0 ;; esac',
		...(selector.legacyCommandMarkers ?? [])
			.filter(Boolean)
			.map(
				(marker) =>
					`if pgrep -f -- ${boxShellQuote(boxProcessMarkerPattern(marker))} >/dev/null; then printf active; exit 0; else [ "$?" = 1 ] || { printf unknown; exit 0; }; fi`,
			),
		"printf inactive",
	].join("\n");
