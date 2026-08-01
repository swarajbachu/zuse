const LOG_DEDUP_WINDOW_MS = 30_000;

// Codex uses tracing's pretty formatter for interactive app-server processes.
// Strip its terminal styling before deriving a stable diagnostic identity.
const ANSI_CONTROL_SEQUENCE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI terminal control sequences are the intended input.
	/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

const stripTerminalFormatting = (line: string): string =>
	line.replace(ANSI_CONTROL_SEQUENCE, "");

const jsonLogCategory = (line: string): string | null => {
	try {
		const parsed = JSON.parse(line) as {
			readonly target?: unknown;
			readonly fields?: { readonly message?: unknown };
		};
		if (
			typeof parsed.target !== "string" ||
			typeof parsed.fields?.message !== "string"
		) {
			return null;
		}
		return `${parsed.target}: ${parsed.fields.message}`;
	} catch {
		return null;
	}
};

const stderrCategory = (line: string): string | null => {
	const stable = stripTerminalFormatting(jsonLogCategory(line) ?? line);
	if (
		stable.includes("rmcp::transport::worker") &&
		stable.includes("Auth(AuthorizationRequired)")
	) {
		return null;
	}
	if (stable.includes("codex_core_skills::loader")) return "skill-loader";
	if (stable.includes("codex_core_skills::service")) return "skill-installer";
	if (stable.includes("initialize sqlite state runtime"))
		return "state-runtime";
	if (stable.includes("rmcp::transport::worker")) return "mcp-transport";
	if (stable.includes("codex_models_manager::cache")) return "models-cache";
	return stable
		.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, "")
		.replaceAll(
			/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
			"<id>",
		);
};

export const createDeduplicatingStderrReporter = (
	options: {
		readonly now?: () => number;
		readonly warn?: (message: string) => void;
		readonly windowMs?: number;
	} = {},
): ((text: string) => void) => {
	const now = options.now ?? Date.now;
	const warn = options.warn ?? console.warn;
	const windowMs = options.windowMs ?? LOG_DEDUP_WINDOW_MS;
	const state = new Map<string, { lastLoggedAt: number; suppressed: number }>();

	return (text) => {
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (line.length === 0) continue;
			const category = stderrCategory(line);
			if (category === null) continue;
			const previous = state.get(category);
			const timestamp = now();
			if (
				previous !== undefined &&
				timestamp - previous.lastLoggedAt < windowMs
			) {
				previous.suppressed += 1;
				continue;
			}
			if (previous !== undefined && previous.suppressed > 0) {
				warn(
					`[codex-app-server] suppressed ${previous.suppressed} repeated ${category} messages`,
				);
			}
			warn(`[codex-app-server] ${line}`);
			state.set(category, { lastLoggedAt: timestamp, suppressed: 0 });
		}
	};
};

/** Process-wide reporter shared by control, mutation, and session clients. */
export const reportCodexStderr = createDeduplicatingStderrReporter();
