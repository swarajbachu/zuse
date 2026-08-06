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
	for (let index = 1; index < normalizedArgv.length; index += 1) {
		const part = normalizedArgv[index];
		if (part === undefined) break;
		if (part === "--data-dir") {
			const value = normalizedArgv[index + 1];
			if (value === undefined || value.startsWith("-")) {
				throw new Error("--data-dir requires a value.");
			}
			dataDir = value;
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
			!["--json", "--foreground", "--force", "--ssh-managed"].includes(flag)
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

	return {
		action: action as ServeAction,
		json: flags.has("--json"),
		foreground: flags.has("--foreground"),
		force: flags.has("--force"),
		sshManaged: flags.has("--ssh-managed"),
		dataDir,
	};
};
