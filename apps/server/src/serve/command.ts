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
}

const MANAGEMENT_ACTIONS = new Set<ServeAction>(ServeAction);

export const parseServeCommand = (
	argv: ReadonlyArray<string>,
): ServeCommand => {
	if (argv[0] !== "serve") {
		throw new Error("Usage: zuse serve [status|stop|update|logout|uninstall]");
	}

	const rest = argv.slice(1);
	const candidate = rest.find((part) => !part.startsWith("-"));
	const action = candidate ?? "start";
	if (!MANAGEMENT_ACTIONS.has(action as ServeAction)) {
		throw new Error(`Unknown zuse serve command "${action}".`);
	}

	const flags = new Set(rest.filter((part) => part.startsWith("-")));
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
	};
};
