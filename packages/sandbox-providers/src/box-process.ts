import type { SandboxProcessInput, SandboxProcessSelector } from "./index.ts";

export const boxShellQuote = (value: string): string =>
	`'${value.replaceAll("'", `'\\''`)}'`;

const processTagFile = (tag: string): string =>
	`${tag.replaceAll(/[^A-Za-z0-9._-]/gu, "-")}.pid`;

/** Separate users and tags without aliasing punctuation in either value. */
export const boxProcessUnit = (user: string, tag: string): string => {
	const hex = (value: string) =>
		Array.from(new TextEncoder().encode(value), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
	return `zuse-process-${hex(user)}-${hex(tag)}.service`;
};

export const boxProcessScript = (input: SandboxProcessInput): string =>
	[
		...(input.tag === undefined
			? []
			: [
					'mkdir -p "$HOME/.zuse-processes"',
					`printf '%s %s\\n' "$(cat /proc/sys/kernel/random/boot_id)" "$$" > "$HOME/.zuse-processes/${processTagFile(input.tag)}"`,
				]),
		...(input.cwd === undefined
			? ['cd "$HOME"']
			: [`cd ${boxShellQuote(input.cwd)}`]),
		...Object.entries(input.env ?? {}).map(
			([key, value]) => `export ${key}=${boxShellQuote(value)}`,
		),
		`exec ${[input.command, ...(input.args ?? [])].map(boxShellQuote).join(" ")}`,
	].join(" && ");

/** Retire pre-systemd processes, retaining the boot-ID fence against PID reuse. */
export const boxProcessCleanupScript = (
	selector: SandboxProcessSelector,
): string =>
	[
		`pidfile="$HOME/.zuse-processes/${processTagFile(selector.tag)}"`,
		'if [ -f "$pidfile" ]; then read -r boot pid < "$pidfile"; if [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] && [ "$pid" -gt 1 ] 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi; rm -f "$pidfile"; fi',
		...(selector.legacyCommandMarkers ?? []).filter(Boolean).map((marker) => {
			const first = marker[0]?.replace(/[\\\]^]/gu, "\\$&");
			const rest = marker.slice(1).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
			return `pkill -KILL -f -- ${boxShellQuote(`[${first}]${rest}`)} || true`;
		}),
		"true",
	].join("; ");

/**
 * Start a transient service only after the caller has authorized this launch.
 * No boot enablement or automatic restart: cloud boot tokens are single-use.
 * systemd owns the entire process tree, including children that call setsid.
 */
export const boxSystemdProcessCommand = (
	input: SandboxProcessInput,
	unit: string,
	selector?: SandboxProcessSelector,
): string => {
	const user = input.user ?? "user";
	const script = [
		"set -e",
		...(selector === undefined
			? []
			: [
					`state=$(systemctl show --property=LoadState --value ${boxShellQuote(unit)} 2>/dev/null || true)`,
					`case "$state" in loaded) systemctl stop ${boxShellQuote(unit)} ;; not-found) ;; *) exit 1 ;; esac`,
					`sudo -n -E -H -u ${boxShellQuote(user)} bash -c ${boxShellQuote(boxProcessCleanupScript(selector))}`,
				]),
		// systemd does not inherit the provider command's account environment.
		// Forward it explicitly, then restore the target user's login identity.
		"environment=()",
		'while IFS= read -r -d "" entry; do case "$entry" in HOME=*|USER=*|LOGNAME=*|SHELL=*|PWD=*|OLDPWD=*|SUDO_*=*|_=*) continue ;; esac; environment+=("--setenv=$entry"); done < <(env -0)',
		`target_home=$(getent passwd ${boxShellQuote(user)} | cut -d: -f6)`,
		'test -n "$target_home"',
		`systemd-run --quiet --collect --service-type=exec --expand-environment=no --description=Zuse-managed-process --unit=${boxShellQuote(unit)} --uid=${boxShellQuote(user)} --property=Restart=no --property=KillMode=control-group --property=TimeoutStopSec=5s "\${environment[@]}" "--setenv=HOME=$target_home" --setenv=${boxShellQuote(`USER=${user}`)} --setenv=${boxShellQuote(`LOGNAME=${user}`)} -- /usr/bin/setsid --wait /bin/bash -c ${boxShellQuote(boxProcessScript(input))}`,
	].join("\n");
	// Keep literal legacy command markers out of the cleanup parent's argv.
	const encoded = btoa(
		Array.from(new TextEncoder().encode(script), (byte) =>
			String.fromCharCode(byte),
		).join(""),
	);
	return `sudo -n -E bash -c ${boxShellQuote(`eval "$(printf %s ${encoded} | base64 -d)"`)}`;
};
