export const ServeAction = [
	"start",
	"status",
	"stop",
	"update",
	"logout",
	"uninstall",
	"help",
	"version",
] as const;
export type ServeAction = (typeof ServeAction)[number];

export interface ServeCommand {
	readonly action: ServeAction;
	readonly json: boolean;
	readonly foreground: boolean;
	readonly force: boolean;
	readonly sshManaged: boolean;
	readonly tailscale: boolean;
	readonly noAccount: boolean;
	readonly lan: boolean;
	readonly host?: string;
	readonly port?: number;
	readonly dataDir?: string;
}

const MANAGEMENT_ACTIONS = new Set<ServeAction>(ServeAction);

export const parseServeCommand = (
	argv: ReadonlyArray<string>,
): ServeCommand => {
	if (argv[0] !== "serve") {
		throw new Error(
			"Usage: zuse serve [start|status|stop|update|logout|uninstall] [options]",
		);
	}
	const normalizedArgv = argv.map((part, index) => {
		if (index !== 1) return part;
		if (part === "--help" || part === "-h") return "help";
		if (part === "--version" || part === "-V") return "version";
		return part;
	});

	const flags = new Set<string>();
	let action: ServeAction = "start";
	let actionProvided = false;
	let dataDir: string | undefined;
	let host: string | undefined;
	let port: number | undefined;
	for (let index = 1; index < normalizedArgv.length; index += 1) {
		const part = normalizedArgv[index];
		if (part === undefined) break;
		if (part === "--data-dir" || part === "--host" || part === "--port") {
			const value = normalizedArgv[index + 1];
			if (value === undefined || value.startsWith("-")) {
				throw new Error(`${part} requires a value.`);
			}
			if (part === "--data-dir") dataDir = value;
			else if (part === "--host") host = value;
			else {
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
					throw new Error("--port requires a port number between 1 and 65535.");
				}
				port = parsed;
			}
			index += 1;
			continue;
		}
		if (part.startsWith("-")) {
			flags.add(part);
			continue;
		}
		if (!actionProvided && MANAGEMENT_ACTIONS.has(part as ServeAction)) {
			action = part as ServeAction;
			actionProvided = true;
			continue;
		}
		throw new Error(`Unknown zuse serve command "${part}".`);
	}

	for (const flag of flags) {
		if (
			![
				"--json",
				"--foreground",
				"--force",
				"--ssh-managed",
				"--tailscale",
				"--no-account",
				"--lan",
			].includes(flag)
		) {
			throw new Error(`Unknown zuse serve option "${flag}".`);
		}
	}
	if (flags.has("--force") && action !== "update") {
		throw new Error("--force is only valid with update.");
	}
	if (flags.has("--json") && action !== "status") {
		throw new Error("--json is only valid with status.");
	}
	if (flags.has("--foreground") && action !== "start") {
		throw new Error("--foreground is only valid when starting Zuse Serve.");
	}
	if (flags.has("--ssh-managed") && action !== "start") {
		throw new Error("--ssh-managed is only valid when starting Zuse Serve.");
	}
	if (flags.has("--tailscale") && action !== "start") {
		throw new Error("--tailscale is only valid when starting Zuse Serve.");
	}
	if (flags.has("--tailscale") && flags.has("--ssh-managed")) {
		throw new Error("--tailscale and --ssh-managed cannot be used together.");
	}
	if ((flags.has("--no-account") || flags.has("--lan")) && action !== "start") {
		throw new Error(
			"--no-account and --lan are only valid when starting Zuse Serve.",
		);
	}
	if ((host !== undefined || port !== undefined) && action !== "start") {
		throw new Error(
			"--host and --port are only valid when starting Zuse Serve.",
		);
	}
	if (
		flags.has("--ssh-managed") &&
		(flags.has("--lan") || host !== undefined)
	) {
		throw new Error("--ssh-managed connections are loopback-only.");
	}
	if (flags.has("--lan") && host !== undefined) {
		throw new Error("Pass either --lan or --host, not both.");
	}

	return {
		action: action as ServeAction,
		json: flags.has("--json"),
		foreground: flags.has("--foreground"),
		force: flags.has("--force"),
		sshManaged: flags.has("--ssh-managed"),
		tailscale: flags.has("--tailscale"),
		noAccount: flags.has("--no-account"),
		lan: flags.has("--lan"),
		host: flags.has("--lan") ? "0.0.0.0" : host,
		port,
		dataDir,
	};
};
