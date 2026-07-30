export const ServeAction = [
	"start",
	"status",
	"stop",
	"update",
	"logout",
	"uninstall",
] as const;
export type ServeAction = (typeof ServeAction)[number];

export interface ServeCommand {
	readonly action: ServeAction;
	readonly json: boolean;
	readonly foreground: boolean;
	readonly force: boolean;
	readonly dataDir?: string;
}

const MANAGEMENT_ACTIONS = new Set<ServeAction>(ServeAction);

export const parseServeCommand = (
	argv: ReadonlyArray<string>,
): ServeCommand => {
	if (argv[0] !== "serve") {
		throw new Error("Usage: zuse serve [status|stop|update|logout|uninstall]");
	}

	const flags = new Set<string>();
	let action: ServeAction = "start";
	let actionProvided = false;
	let dataDir: string | undefined;
	for (let index = 1; index < argv.length; index += 1) {
		const part = argv[index];
		if (part === undefined) break;
		if (part === "--data-dir") {
			const value = argv[index + 1];
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
		if (!["--json", "--foreground", "--force"].includes(flag)) {
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

	return {
		action: action as ServeAction,
		json: flags.has("--json"),
		foreground: flags.has("--foreground"),
		force: flags.has("--force"),
		dataDir,
	};
};
