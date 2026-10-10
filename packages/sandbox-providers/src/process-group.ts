import {
	boxProcessCleanupScript,
	boxProcessMarkerPattern,
	boxProcessScript,
	boxProcessStoppedChecks,
	boxProcessUnit,
} from "./box-process.ts";
import type { SandboxProcessInput, SandboxProcessSelector } from "./index.ts";
import {
	processActivationGuard,
	processShellQuote as quote,
	rootProcessCommand,
} from "./process-activation.ts";
import { PROCESS_SUPERVISOR } from "./process-supervisor.ts";

// Read identity without exposing argv or environment. A PID alone is reusable.
const processIdentity = [
	'process_file="$activation_dir/process"',
	"current_boot=$(cat /proc/sys/kernel/random/boot_id)",
	"process_alive() {",
	'  [ -f "$process_file" ] || return 1',
	'  read -r process_boot process_pid process_start process_generation process_operation < "$process_file" || return 2',
	'  [[ "$process_pid" =~ ^[0-9]+$ ]] && [ "$process_pid" -gt 1 ] || return 2',
	'  [ "$process_boot" = "$current_boot" ] || return 1',
	// A normal supervisor exit proves the entire descendant tree retired. A
	// missing same-boot supervisor alone cannot exclude escaped agent children.
	'  if [ -f "$activation_dir/retired" ] && [ "$(cat "$activation_dir/retired")" = "$process_boot $process_pid $process_start $process_generation $process_operation" ]; then return 1; fi',
	'  if [ -r "/proc/$process_pid/stat" ]; then',
	'  actual_start=$(sed "s/.*) //" "/proc/$process_pid/stat" | awk \'{print $20}\') || return 2',
	'  [ "$actual_start" = "$process_start" ] || return 2',
	"  fi",
	"  ps -eo pgid=,stat= | awk -v group=\"$process_pid\" '$1 == group && $2 !~ /^Z/ {live=1} END {exit !live}' || return 2",
	"}",
];

/** Envd's Start ACK is not activation: the caller awaits this command's exit. */
export const processGroupCommand = (
	input: SandboxProcessInput,
	selector?: SandboxProcessSelector,
): string => {
	const user = input.user ?? "user";
	const tag = selector?.tag ?? input.tag;
	if (tag === undefined) throw new Error("Managed process requires a tag");
	const unit = boxProcessUnit(user, tag);
	const observation = [
		...processIdentity,
		"if process_alive; then",
		'  if [ "$process_generation" = "$generation" ] && [ "$process_operation" = "$operation" ]; then exit 0; fi',
		'else [ "$?" = 1 ]; fi',
	];
	const child = [
		"set -e",
		`activation_dir=${quote(`/var/lib/zuse-process-activations/${unit}`)}`,
		"boot=$(cat /proc/sys/kernel/random/boot_id)",
		"start=$(sed \"s/.*) //\" /proc/$$/stat | awk '{print $20}')",
		`printf '%s %s %s %s %s\\n' "$boot" "$$" "$start" ${input.activation?.generation ?? 0} ${quote(input.activation?.operationId ?? "legacy")} > "$activation_dir/process.next"`,
		'sync -f "$activation_dir/process.next"',
		'mv -f "$activation_dir/process.next" "$activation_dir/process"',
		'sync -f "$activation_dir"',
		// The child shares the launch lock until its identity is durable. Even
		// if envd/parent dies here, another launch cannot miss this process.
		"exec 9>&-",
		`exec python3 -c ${quote(PROCESS_SUPERVISOR)} "$activation_dir/retired" "$boot" "$start" ${input.activation?.generation ?? 0} ${quote(input.activation?.operationId ?? "legacy")} sudo -n -E -H -u ${quote(user)} bash -c ${quote(boxProcessScript(input))}`,
	].join("\n");
	return rootProcessCommand(
		[
			...processActivationGuard(input, unit, observation),
			...processIdentity,
			...(selector === undefined
				? []
				: [
						"if process_alive; then",
						'  kill -TERM -- "-$process_pid"',
						"  for attempt in {1..100}; do if ! process_alive; then break; fi; sleep 0.1; done",
						'  if process_alive; then exit 1; else [ "$?" = 1 ]; fi',
						'else [ "$?" = 1 ]; fi',
						`sudo -n -E -H -u ${quote(user)} bash -c ${quote(boxProcessCleanupScript(selector))}`,
						...boxProcessStoppedChecks(selector),
					]),
			// A live group may not be overwritten by a start-only call.
			'if process_alive; then exit 1; else [ "$?" = 1 ]; fi',
			'rm -f -- "$process_file"',
			`/usr/bin/setsid /bin/bash -c ${quote(child)} >"$activation_dir/output.log" 2>&1 </dev/null &`,
			"child_pid=$!",
			"for attempt in {1..100}; do",
			'  if process_alive && [ "$process_pid" = "$child_pid" ]; then exit 0; fi',
			'  kill -0 "$child_pid" 2>/dev/null || exit 1',
			"  sleep 0.01",
			"done",
			"exit 1",
		].join("\n"),
	);
};

export const processGroupInspectionCommand = (
	selector: SandboxProcessSelector,
	user: string,
): string =>
	rootProcessCommand(
		[
			"set -e",
			`activation_dir=${quote(`/var/lib/zuse-process-activations/${boxProcessUnit(user, selector.tag)}`)}`,
			...processIdentity,
			'if process_alive; then printf active; exit 0; else [ "$?" = 1 ] || { printf unknown; exit 0; }; fi',
			...(selector.legacyCommandMarkers ?? [])
				.filter(Boolean)
				.map(
					(marker) =>
						`if pgrep -f -- ${quote(boxProcessMarkerPattern(marker))} >/dev/null; then printf active; exit 0; else [ "$?" = 1 ] || { printf unknown; exit 0; }; fi`,
				),
			"printf inactive",
		].join("\n"),
	);
