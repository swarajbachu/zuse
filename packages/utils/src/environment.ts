/** Shared policy for environment selection. No storage or process-global state. */
export interface EnvironmentBinding {
	readonly id: string;
	readonly name: string;
	readonly scope: "personal" | "team";
	readonly projectIds: readonly string[] | null;
	readonly excludedProjectIds: readonly string[];
	readonly target: "local" | "cloud" | "both";
}

export function validateEnvironmentName(name: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))
		throw new Error("invalid_environment_name");
	if (
		["__proto__", "constructor", "prototype"].includes(name) ||
		/^ZUSE_/i.test(name) ||
		[
			"NODE_OPTIONS",
			"LD_PRELOAD",
			"LD_LIBRARY_PATH",
			"DYLD_INSERT_LIBRARIES",
		].includes(name.toUpperCase())
	)
		throw new Error("reserved_environment_name");
}

export function validateEnvironmentBindings(
	entries: readonly EnvironmentBinding[],
): void {
	for (const entry of entries) {
		validateEnvironmentName(entry.name);
		if (entry.projectIds?.length === 0)
			throw new Error("select_at_least_one_project");
		for (const other of entries) {
			if (
				other === entry ||
				other.id === entry.id ||
				other.name !== entry.name ||
				other.scope !== entry.scope
			)
				continue;
			if (
				other.target !== "both" &&
				entry.target !== "both" &&
				other.target !== entry.target
			)
				continue;
			if (entry.projectIds === null && other.projectIds === null)
				throw new Error("duplicate_environment_default");
			if (
				entry.projectIds !== null &&
				other.projectIds !== null &&
				entry.projectIds.some(
					(id) =>
						other.projectIds?.includes(id) &&
						!entry.excludedProjectIds.includes(id) &&
						!other.excludedProjectIds.includes(id),
				)
			)
				throw new Error("overlapping_environment_projects");
		}
	}
}

export function selectEnvironmentBindings<T extends EnvironmentBinding>(
	entries: readonly T[],
	projectId: string,
	target: "local" | "cloud",
	shared = false,
): readonly T[] {
	const chosen = new Map<string, T>();
	const rank = (entry: T) =>
		(entry.projectIds === null ? 0 : 2) + (entry.scope === "personal" ? 1 : 0);
	for (const entry of entries) {
		if (shared && entry.scope === "personal") continue;
		if (entry.target !== "both" && entry.target !== target) continue;
		if (entry.excludedProjectIds.includes(projectId)) continue;
		if (entry.projectIds !== null && !entry.projectIds.includes(projectId))
			continue;
		const previous = chosen.get(entry.name);
		if (!previous || rank(entry) > rank(previous))
			chosen.set(entry.name, entry);
	}
	return [...chosen.values()];
}

/** Parse dotenv as data. Deliberately does not interpolate or execute anything. */
export function parseEnvironmentFile(
	text: string,
): readonly { name: string; value: string }[] {
	if (text.length > 1_048_576) throw new Error("environment_file_too_large");
	const input = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const result: { name: string; value: string }[] = [];
	let cursor = 0;
	while (cursor < input.length) {
		const rest = input.slice(cursor);
		const blank = /^(?:[ \t]*(?:#[^\n]*)?\n|[ \t]+$)/.exec(rest);
		if (blank) {
			cursor += blank[0].length;
			continue;
		}
		if (/^[ \t]*#/.test(rest)) break;
		const start =
			/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(
				rest,
			);
		if (!start)
			throw new Error(
				`invalid_environment_line_${input.slice(0, cursor).split("\n").length}`,
			);
		const name = start[1] ?? "";
		validateEnvironmentName(name);
		cursor += start[0].length;
		let value = "";
		const quote = input[cursor];
		if (quote === '"' || quote === "'") {
			cursor++;
			let closed = false;
			while (cursor < input.length) {
				const char = input[cursor++];
				if (char === quote) {
					closed = true;
					break;
				}
				if (char === "\\" && quote === '"') {
					const escaped = input[cursor++];
					value +=
						escaped === "n"
							? "\n"
							: escaped === "r"
								? "\r"
								: escaped === '"' || escaped === "\\"
									? escaped
									: `\\${escaped ?? ""}`;
				} else value += char;
			}
			if (!closed) throw new Error("unterminated_environment_value");
			const trailing = /^[ \t]*(?:#[^\n]*)?(?:\n|$)/.exec(input.slice(cursor));
			if (!trailing) throw new Error("invalid_environment_trailing_content");
			cursor += trailing[0].length;
		} else {
			const end = input.indexOf("\n", cursor);
			value =
				input
					.slice(cursor, end < 0 ? undefined : end)
					.split("#")[0]
					?.trimEnd() ?? "";
			cursor = end < 0 ? input.length : end + 1;
		}
		result.push({ name, value });
	}
	return result;
}

/** Masks only observer output; never attach to stdin or an application pipe. */
export function createSecretMasker(values: readonly string[]) {
	interface Node {
		readonly children: Map<string, Node>;
		terminal: boolean;
	}
	const root: Node = { children: new Map(), terminal: false };
	for (const value of new Set(values)) {
		if (value.length === 0) continue;
		let node = root;
		for (let index = 0; index < value.length; index++) {
			const char = value.charAt(index);
			let child = node.children.get(char);
			if (!child) {
				child = { children: new Map(), terminal: false };
				node.children.set(char, child);
			}
			node = child;
		}
		node.terminal = true;
	}
	let pending = "";
	const drain = (final: boolean): string => {
		if (root.children.size === 0) {
			const result = pending;
			pending = "";
			return result;
		}
		const output: string[] = [];
		let cursor = 0;
		while (cursor < pending.length) {
			let node = root;
			let end = cursor;
			let matched = 0;
			while (end < pending.length) {
				const child = node.children.get(pending.charAt(end));
				if (!child) break;
				node = child;
				end++;
				if (node.terminal) matched = end - cursor;
			}
			if (!final && end === pending.length && node.children.size > 0) break;
			if (matched > 0) {
				output.push("[secret]");
				cursor += matched;
			} else {
				output.push(pending.charAt(cursor));
				cursor++;
			}
		}
		pending = pending.slice(cursor);
		return output.join("");
	};
	return {
		write(chunk: string): string {
			pending += chunk;
			return drain(false);
		},
		end(): string {
			return drain(true);
		},
	};
}

export function maskSecrets(text: string, values: readonly string[]): string {
	const masker = createSecretMasker(values);
	return masker.write(text) + masker.end();
}
