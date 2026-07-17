import { canonicalizeToolInput } from "@zuse/agents/kernel/tool-input";
import {
	type AgentEvent,
	type AgentItemId,
	isRedundantShellDescription,
} from "@zuse/contracts";

/**
 * Shared translator for Agent Client Protocol (ACP) `session/update` frames.
 * Shared by the remaining ACP-backed drivers. The renderer expects every
 * provider's tool calls to look
 * like Claude's (see the "Normalized Tool-Call Contract" doc-block above
 * `ToolUseEvent` in `packages/contracts/src/agent.ts`), so this translator
 * coerces ACP frames into that shape.
 *
 * Per-provider quirks (Gemini's `kind === "think"` skip, etc.) live in a
 * single `provider` switch instead of three forks of the same function.
 *
 * Set `MEMOIZE_DEBUG_ACP=1` to trace every translator decision to stderr
 * (kind, status, what events were emitted). Pair with `MEMOIZE_DEBUG_<P>`
 * (GEMINI/GROK) for raw JSON-RPC frame logs in the drivers.
 */

export type AcpProviderTag = "grok" | "gemini";

const ACP_TRACE = process.env.MEMOIZE_DEBUG_ACP === "1";

const trace = (provider: AcpProviderTag, msg: string): void => {
	if (!ACP_TRACE) return;
	process.stderr.write(`[acp.${provider}] ${msg}\n`);
};

const safePreview = (v: unknown, max = 240): string => {
	try {
		const s = typeof v === "string" ? v : JSON.stringify(v);
		if (s === undefined) return "undefined";
		return s.length > max ? `${s.slice(0, max - 1)}…` : s;
	} catch {
		return "(unserialisable)";
	}
};

const toolInputFingerprint = (input: unknown): string =>
	(() => {
		try {
			return JSON.stringify({ input: canonicalizeToolInput(input) });
		} catch {
			return String(input);
		}
	})();

let itemCounter = 0;
const nextItemId = (): AgentItemId =>
	`i_acp_${Date.now()}_${++itemCounter}` as AgentItemId;

const tryParseJson = (raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
};

const asText = (v: unknown): string | null => {
	if (typeof v === "string") return v;
	if (v !== null && typeof v === "object" && "text" in v) {
		const t = (v as { text: unknown }).text;
		return typeof t === "string" ? t : null;
	}
	return null;
};

const extractMessageText = (content: unknown): string | null => {
	if (!Array.isArray(content)) return asText(content);
	const parts: string[] = [];
	for (const item of content) {
		if (item !== null && typeof item === "object" && "text" in item) {
			const t = (item as Record<string, unknown>)["text"];
			if (typeof t === "string") parts.push(t);
		}
	}
	return parts.length > 0 ? parts.join("") : null;
};

const extractCallId = (u: Record<string, unknown>): AgentItemId => {
	const raw =
		typeof u["toolCallId"] === "string"
			? u["toolCallId"]
			: typeof u["call_id"] === "string"
				? u["call_id"]
				: typeof u["callId"] === "string"
					? u["callId"]
					: typeof u["id"] === "string"
						? u["id"]
						: null;
	return raw !== null ? (raw as AgentItemId) : nextItemId();
};

/**
 * Convert a snake_case or camelCase identifier into a nice TitleCase label
 * suitable for display in the UI (e.g. "list_dir" → "List Dir",
 * "readFile" → "Read File"). Used both for unknown tool normalization and
 * as the fallback label in the renderer when we still don't have an exact
 * mapping.
 */
const toNiceToolLabel = (raw: string): string => {
	if (!raw) return "Tool";
	// Split on underscores or camelCase boundaries
	const words = raw
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
	return words.join(" ");
};

const GENERIC_ACP_TOOL_KINDS = new Set(["other", "tool", "mcp"]);

/**
 * Map an ACP `kind` (or tool name) string to the Claude-canonical tool name
 * the renderer's ToolRow switch + iconForTool expect. We now handle the
 * full set of common Grok / ACP FS & shell tools so "list_dir", "read_file"
 * etc. stop showing up as the generic "tool" / "Other" rows the user saw.
 */
const normalizeAcpKind = (rawKind: string): string => {
	const k = rawKind.toLowerCase();
	if (k.startsWith("zuse-browser__browser_")) {
		return `mcp__zuse__${k.slice("zuse-browser__".length)}`;
	}
	if (k.startsWith("mcp__zuse-browser__browser_")) {
		return `mcp__zuse__${k.slice("mcp__zuse-browser__".length)}`;
	}
	if (k.startsWith("zuse-orchestration__")) {
		return `mcp__${k}`;
	}
	if (k.startsWith("mcp__zuse-orchestration__")) {
		return k;
	}
	if (
		k === "view_image" ||
		k === "zuse-images__view_image" ||
		k === "mcp__zuse-images__view_image"
	) {
		return "ViewImage";
	}
	switch (k) {
		case "browser_navigate":
		case "browser_screenshot":
		case "browser_snapshot":
		case "browser_click":
		case "browser_type":
		case "browser_wait":
		case "browser_scroll":
		case "browser_hover":
		case "browser_select":
		case "browser_press":
		case "browser_read":
		case "browser_history":
		case "browser_console":
		case "browser_network":
		case "browser_fill_form":
		case "browser_dialog":
		case "browser_login":
			return `mcp__zuse__${k}`;
		case "read":
		case "read_file":
		case "readfile":
			return "Read";
		case "bash":
		case "execute":
		case "run_command":
		case "run_terminal_cmd":
		case "shell":
		case "shell_command":
		case "terminal":
			return "Bash";
		case "edit":
		case "edit_file":
		case "editfile":
		case "search_replace":
		case "searchreplace":
		case "str_replace":
		case "str_replace_editor":
			return "Edit";
		case "write":
		case "write_file":
		case "writefile":
			return "Write";
		case "grep":
		case "grep_search":
		case "grepsearch":
		case "search":
		case "search_files":
		case "searchfiles":
			return "Grep";
		case "glob":
		case "glob_files":
		case "globfiles":
			return "Glob";
		case "websearch":
		case "web_search":
			return "WebSearch";
		case "webfetch":
		case "web_fetch":
		case "fetch":
		case "fetch_url":
			return "WebFetch";
		case "list_dir":
		case "listdir":
		case "list_directory":
		case "directory":
			return "ListDir";
		case "multi_edit":
		case "multiedit":
			return "MultiEdit";
		case "todo_write":
		case "todowrite":
			return "TodoWrite";
		default:
			// Fall back to a clean Title Case label (handles the rest of Grok's
			// native tools gracefully even if we haven't wired a dedicated case
			// in the renderer yet).
			return toNiceToolLabel(rawKind);
	}
};

const firstLocationPath = (u: Record<string, unknown>): string | null => {
	const locations = u["locations"];
	if (!Array.isArray(locations) || locations.length === 0) return null;
	const loc = locations[0];
	if (loc === null || typeof loc !== "object") return null;
	const p = (loc as Record<string, unknown>)["path"];
	return typeof p === "string" ? p : null;
};

/**
 * Walk an ACP `tool_call.content` array (or single block) and pluck the
 * first `diff` block if present. Gemini's ACP emits these for `edit` calls:
 *   `{ type: "diff", path, oldText, newText }`
 * (older variants spell them `old_text` / `new_text`).
 */
const extractDiffBlock = (
	content: unknown,
): { path?: string; oldText: string; newText: string } | null => {
	const items = Array.isArray(content) ? content : [content];
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const b = item as Record<string, unknown>;
		if (b["type"] !== "diff") continue;
		const oldText =
			typeof b["oldText"] === "string"
				? (b["oldText"] as string)
				: typeof b["old_text"] === "string"
					? (b["old_text"] as string)
					: null;
		const newText =
			typeof b["newText"] === "string"
				? (b["newText"] as string)
				: typeof b["new_text"] === "string"
					? (b["new_text"] as string)
					: null;
		if (oldText === null || newText === null) continue;
		const path =
			typeof b["path"] === "string" ? (b["path"] as string) : undefined;
		return { path, oldText, newText };
	}
	return null;
};

/**
 * Locate a Grok `SearchReplace` edit envelope anywhere in an update's
 * result-bearing fields. Grok returns the applied diff in the tool *result*
 * (not the call input), shaped like:
 *   { type: "SearchReplace", EditsApplied: { absolute_path, old_string,
 *     new_string, edits: { details: [{ old_string, new_string, ... }] } } }
 * Walks arrays + one level of `content` wrapping so we find it regardless of
 * how the provider nests it.
 */
const asSearchReplaceEnvelope = (
	v: unknown,
): Record<string, unknown> | null => {
	if (Array.isArray(v)) {
		for (const item of v) {
			const env = asSearchReplaceEnvelope(item);
			if (env !== null) return env;
		}
		return null;
	}
	if (v === null || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	const type =
		typeof o["type"] === "string" ? (o["type"] as string).toLowerCase() : null;
	if (
		type === "searchreplace" ||
		type === "search_replace" ||
		"EditsApplied" in o
	) {
		return o;
	}
	if ("content" in o) return asSearchReplaceEnvelope(o["content"]);
	return null;
};

const findSearchReplaceEnvelope = (
	u: Record<string, unknown>,
): Record<string, unknown> | null => {
	for (const key of ["output", "rawOutput", "result", "content"] as const) {
		if (u[key] === undefined) continue;
		const env = asSearchReplaceEnvelope(u[key]);
		if (env !== null) return env;
	}
	return null;
};

/**
 * Pull `(file_path, [{ old_string, new_string }])` out of a SearchReplace
 * envelope so the Edit/MultiEdit row can render a real diff. Tolerates the
 * fields living either under `EditsApplied` or at the top level, and both the
 * `edits.details[]` array form and a single top-level old/new pair.
 */
const extractSearchReplaceEdits = (
	env: Record<string, unknown>,
): {
	filePath: string | null;
	edits: ReadonlyArray<{ old_string: string; new_string: string }>;
} => {
	const applied =
		env["EditsApplied"] !== null && typeof env["EditsApplied"] === "object"
			? (env["EditsApplied"] as Record<string, unknown>)
			: env;

	const strField = (
		src: Record<string, unknown>,
		key: string,
	): string | null =>
		typeof src[key] === "string" && (src[key] as string).length > 0
			? (src[key] as string)
			: null;

	const filePath =
		strField(applied, "absolute_path") ??
		strField(applied, "file_path") ??
		strField(applied, "path") ??
		strField(env, "file_path") ??
		strField(env, "path");

	const edits: Array<{ old_string: string; new_string: string }> = [];
	const editsContainer =
		applied["edits"] !== null && typeof applied["edits"] === "object"
			? (applied["edits"] as Record<string, unknown>)
			: null;
	const details =
		editsContainer !== null && Array.isArray(editsContainer["details"])
			? (editsContainer["details"] as unknown[])
			: null;
	if (details !== null) {
		for (const d of details) {
			if (d === null || typeof d !== "object") continue;
			const r = d as Record<string, unknown>;
			const oldS =
				typeof r["old_string"] === "string"
					? (r["old_string"] as string)
					: null;
			const newS =
				typeof r["new_string"] === "string"
					? (r["new_string"] as string)
					: null;
			if (oldS !== null || newS !== null) {
				edits.push({ old_string: oldS ?? "", new_string: newS ?? "" });
			}
		}
	}
	if (edits.length === 0) {
		const oldS =
			typeof applied["old_string"] === "string"
				? (applied["old_string"] as string)
				: null;
		const newS =
			typeof applied["new_string"] === "string"
				? (applied["new_string"] as string)
				: null;
		if (oldS !== null || newS !== null) {
			edits.push({ old_string: oldS ?? "", new_string: newS ?? "" });
		}
	}
	return { filePath, edits };
};

/**
 * Build a canonical `input` object for the given tool name. ACP frames put
 * the same info in several different fields depending on provider/version,
 * so we look in each common spelling. The keys we emit match the
 * "Normalized Tool-Call Contract" enumerated next to `ToolUseEvent`.
 */
const buildCanonicalInput = (
	toolName: string,
	u: Record<string, unknown>,
): unknown => {
	const title = typeof u["title"] === "string" ? (u["title"] as string) : null;

	// Cursor stuffs the tool arguments under `rawInput` instead of `input` /
	// `arguments` / `locations` — merge it into the lookup so the per-tool
	// cases below can find `file_path`/`path`/`command`/etc the same way as
	// for other providers.
	const rawInput =
		u["rawInput"] !== null &&
		typeof u["rawInput"] === "object" &&
		Object.keys(u["rawInput"] as Record<string, unknown>).length > 0
			? (u["rawInput"] as Record<string, unknown>)
			: null;

	const pathFrom = (src: Record<string, unknown>): string | null => {
		const v =
			typeof src["file_path"] === "string"
				? (src["file_path"] as string)
				: typeof src["target_file"] === "string"
					? (src["target_file"] as string)
					: typeof src["filePath"] === "string"
						? (src["filePath"] as string)
						: typeof src["path"] === "string"
							? (src["path"] as string)
							: null;
		return v !== null && v.length > 0 ? v : null;
	};

	switch (toolName) {
		case "Edit":
		case "MultiEdit": {
			// Grok's SearchReplace returns the applied diff in its result envelope,
			// not the call input — recover it so the row shows a real diff.
			const sr = findSearchReplaceEnvelope(u);
			if (sr !== null) {
				const { filePath, edits } = extractSearchReplaceEdits(sr);
				if (edits.length > 0) {
					const fp =
						filePath ??
						firstLocationPath(u) ??
						(rawInput !== null ? pathFrom(rawInput) : null) ??
						"";
					if (edits.length === 1) {
						return {
							file_path: fp,
							old_string: edits[0]!.old_string,
							new_string: edits[0]!.new_string,
						};
					}
					return { file_path: fp, edits };
				}
			}
			const diff = extractDiffBlock(u["content"]);
			if (diff !== null) {
				return {
					file_path:
						diff.path ??
						firstLocationPath(u) ??
						(rawInput !== null ? pathFrom(rawInput) : null) ??
						"",
					old_string: diff.oldText,
					new_string: diff.newText,
				};
			}
			const file_path =
				firstLocationPath(u) ?? (rawInput !== null ? pathFrom(rawInput) : null);
			if (file_path !== null) return { file_path };
			break;
		}
		case "Write": {
			const file_path =
				firstLocationPath(u) ?? (rawInput !== null ? pathFrom(rawInput) : null);
			const content =
				typeof u["content"] === "string"
					? (u["content"] as string)
					: (extractMessageText(u["content"]) ??
						(rawInput !== null && typeof rawInput["content"] === "string"
							? (rawInput["content"] as string)
							: null));
			const out: Record<string, unknown> = {};
			if (file_path !== null) out["file_path"] = file_path;
			if (content !== null) out["content"] = content;
			return Object.keys(out).length > 0 ? out : null;
		}
		case "Read":
		case "ViewImage": {
			const file_path =
				firstLocationPath(u) ?? (rawInput !== null ? pathFrom(rawInput) : null);
			if (file_path !== null) {
				const out: Record<string, unknown> = { file_path };
				if (typeof u["offset"] === "number") out["offset"] = u["offset"];
				if (typeof u["limit"] === "number") out["limit"] = u["limit"];
				return out;
			}
			break;
		}
		case "Bash": {
			const command =
				typeof u["command"] === "string"
					? (u["command"] as string)
					: typeof u["cmd"] === "string"
						? (u["cmd"] as string)
						: rawInput !== null && typeof rawInput["command"] === "string"
							? (rawInput["command"] as string)
							: null;
			if (command !== null) {
				const out: Record<string, unknown> = { command };
				if (title !== null && !isRedundantShellDescription(title, command)) {
					out["description"] = title;
				}
				return out;
			}
			break;
		}
		case "Grep":
		case "Glob": {
			const out: Record<string, unknown> = {};
			const src = rawInput ?? u;
			if (typeof src["pattern"] === "string") out["pattern"] = src["pattern"];
			if (typeof src["path"] === "string") out["path"] = src["path"];
			if (typeof src["glob"] === "string") out["glob"] = src["glob"];
			if (Object.keys(out).length > 0) return out;
			break;
		}
		case "WebSearch": {
			const query =
				typeof u["query"] === "string"
					? (u["query"] as string)
					: typeof u["q"] === "string"
						? (u["q"] as string)
						: title;
			if (query !== null) return { query };
			break;
		}
		case "WebFetch": {
			const url = typeof u["url"] === "string" ? (u["url"] as string) : null;
			if (url !== null) {
				const out: Record<string, unknown> = { url };
				if (title !== null) out["prompt"] = title;
				return out;
			}
			break;
		}
	}

	// Generic fallback — preserve whatever the provider sent so the renderer
	// can still render *something* even for tool names we don't recognize.
	if (rawInput !== null) {
		return rawInput;
	}
	if (u["input"] !== undefined) return u["input"];
	if (u["arguments"] !== undefined) {
		const a = u["arguments"];
		return typeof a === "string" ? tryParseJson(a) : a;
	}
	if (u["command"] !== undefined) return { command: u["command"] };
	const file_path = firstLocationPath(u);
	if (file_path !== null) return { file_path };
	return title !== null ? { description: title } : null;
};

const extractToolName = (u: Record<string, unknown>): string => {
	// Direct fields first (most ACP implementations put the kind here)
	const kind = typeof u["kind"] === "string" ? (u["kind"] as string) : null;
	if (
		kind !== null &&
		kind.length > 0 &&
		!GENERIC_ACP_TOOL_KINDS.has(kind.toLowerCase())
	) {
		return normalizeAcpKind(kind);
	}

	if (typeof u["tool"] === "string" && u["tool"].length > 0)
		return u["tool"] as string;
	if (typeof u["name"] === "string" && u["name"].length > 0)
		return u["name"] as string;
	if (typeof u["execution"] === "string" && u["execution"].length > 0)
		return u["execution"] as string;
	if (typeof u["command"] === "string" && u["command"].length > 0)
		return u["command"] as string;

	// Grok (and some other agents) sometimes nest the tool identity under
	// toolCall / tool_call / toolInfo. Look one level deeper so we don't
	// fall back to the useless generic "tool" label the user reported.
	const nestedCandidates = [
		u["toolCall"],
		u["tool_call"],
		u["toolInfo"],
		u["tool_info"],
		u["call"],
	];
	for (const cand of nestedCandidates) {
		if (cand && typeof cand === "object") {
			const c = cand as Record<string, unknown>;
			const nestedKind =
				typeof c["kind"] === "string" ? (c["kind"] as string) : null;
			if (nestedKind && nestedKind.length > 0)
				return normalizeAcpKind(nestedKind);
			const nestedName =
				(typeof c["name"] === "string" && c["name"]) ||
				(typeof c["tool"] === "string" && c["tool"]) ||
				(typeof c["command"] === "string" && c["command"]);
			if (
				nestedName &&
				typeof nestedName === "string" &&
				nestedName.length > 0
			) {
				return normalizeAcpKind(nestedName);
			}
		}
	}

	// Last-ditch: sometimes the title/description of the call *is* the tool
	// (e.g. Grok sends title: "list_dir" with no kind). Use it.
	const title = typeof u["title"] === "string" ? (u["title"] as string) : null;
	if (title && title.length > 0 && title.length < 40) {
		// Heuristic: if it looks like a tool identifier, normalize it.
		if (
			/^(?:mcp__)?zuse-(?:browser|images|orchestration)__[a-z0-9_]+$/i.test(
				title,
			)
		) {
			return normalizeAcpKind(title);
		}
		if (/^[a-z0-9_]+$/i.test(title)) return normalizeAcpKind(title);
	}

	// Give the caller a chance to log the raw payload under debug before we
	// return the ultimate fallback.
	return "tool";
};

// Grok (and some MCP servers) emit tool results as an array of content blocks
// where the actual text is buried two levels deep:
//   [{ type: "content", content: { type: "text", text: "..." } }]
// We flatten that into a single string so the renderer can show the file
// contents directly instead of a stringified JSON blob.
const flattenMcpContent = (val: unknown): string | null => {
	if (!Array.isArray(val) || val.length === 0) return null;
	const parts: string[] = [];
	for (const block of val) {
		if (block === null || typeof block !== "object") return null;
		const b = block as Record<string, unknown>;
		if (typeof b["text"] === "string") {
			parts.push(b["text"] as string);
			continue;
		}
		const inner = b["content"];
		if (inner !== null && typeof inner === "object") {
			const it = (inner as Record<string, unknown>)["text"];
			if (typeof it === "string") {
				parts.push(it);
				continue;
			}
		}
		// Unknown block shape — bail out so the caller falls back to raw value.
		return null;
	}
	return parts.join("");
};

const unwrap = (o: unknown): unknown => {
	const flat = flattenMcpContent(o);
	if (flat !== null) return flat;
	if (o !== null && typeof o === "object" && "content" in o) {
		const nested = (o as Record<string, unknown>)["content"];
		const flatNested = flattenMcpContent(nested);
		if (flatNested !== null) return flatNested;
		return nested ?? o;
	}
	return o;
};

/**
 * Grok serialises Node streams (a tool's stdout/stderr) as JSON — either a
 * bare array of byte values `[60, 119, …]` or `{ type: "Buffer", data: [...] }`.
 * Decode either back to a UTF-8 string. Returns null for anything that isn't a
 * clean byte array so callers can fall back to the raw value.
 */
const decodeByteArray = (v: unknown): string | null => {
	const data = Array.isArray(v)
		? v
		: v !== null &&
				typeof v === "object" &&
				Array.isArray((v as Record<string, unknown>)["data"])
			? ((v as Record<string, unknown>)["data"] as unknown[])
			: null;
	if (data === null || data.length === 0) return null;
	const bytes = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i++) {
		const n = data[i];
		if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) {
			return null;
		}
		bytes[i] = n;
	}
	try {
		return new TextDecoder("utf-8").decode(bytes);
	} catch {
		return null;
	}
};

/**
 * Grok's read tool prefixes every line with an `N→` marker (`1→{`, `2→  …`).
 * The renderer's CodeBlock draws its own line-number gutter, so strip the
 * markers (keeping the original indentation that follows) to avoid a doubled
 * gutter.
 */
const stripLineMarkers = (content: string): string =>
	content
		.split("\n")
		.map((line) => line.replace(/^\s*\d+→/, ""))
		.join("\n");

/**
 * Flatten Grok's grep result envelope into a grouped, human-readable string:
 *
 *   relative/path/to/file.tsx
 *   \t13: matching line content
 *   \t40: another match
 *   other/file.tsx
 *   \t5: ...
 *
 * The renderer's Grep view parses this back into per-file groups with a file
 * chip + the matched lines. Paths are relativised against the workspace root
 * (recovered from the `<workspace_result workspace_path="…">` marker Grok
 * embeds in `stdout`) so they read as short repo paths, not absolute ones.
 */
const buildGrepText = (o: Record<string, unknown>): string | null => {
	const fileMatches = o["file_matches"];
	if (!Array.isArray(fileMatches) || fileMatches.length === 0) return null;

	let root: string | null = null;
	const stdoutText =
		decodeByteArray(o["stdout"]) ??
		(typeof o["stdout"] === "string" ? (o["stdout"] as string) : null);
	if (stdoutText !== null) {
		const m = stdoutText.match(/workspace_path="([^"]+)"/);
		if (m !== null) root = m[1] ?? null;
	}
	const rel = (p: string): string =>
		root !== null && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;

	const lines: string[] = [];
	for (const fm of fileMatches) {
		if (fm === null || typeof fm !== "object") continue;
		const f = fm as Record<string, unknown>;
		const path = typeof f["path"] === "string" ? (f["path"] as string) : null;
		if (path === null || path.length === 0) continue;
		lines.push(rel(path));
		const matches = Array.isArray(f["matches"]) ? f["matches"] : [];
		for (const mt of matches) {
			if (mt === null || typeof mt !== "object") continue;
			const m = mt as Record<string, unknown>;
			const ln =
				typeof m["line_number"] === "number"
					? (m["line_number"] as number)
					: null;
			const content =
				typeof m["content"] === "string" ? (m["content"] as string).trim() : "";
			lines.push(`\t${ln !== null ? `${ln}: ` : ""}${content}`);
		}
	}
	return lines.length > 0 ? lines.join("\n") : null;
};

/**
 * Grok's internal FS/search tools (list_dir, grep, shell, …) return structured
 * result envelopes rather than plain text. Recognise the common shapes and
 * flatten them to the clean text the renderer's per-tool views already know how
 * to display, so the user sees a tidy file tree / match list instead of a raw
 * JSON blob or an array of char codes.
 */
/**
 * Markers that identify a Grok tool-result envelope. We only re-parse a string
 * result when it carries one of these, so a real file whose contents merely
 * happen to be JSON is never disturbed.
 */
const ENVELOPE_SIGNATURE =
	/"type"\s*:\s*"(ReadFile|ListDir|GrepSearch|SearchReplace)"|"FileContent"|"file_matches"|"EditsApplied"/;

const normalizeNativeToolResult = (output: unknown): unknown => {
	// Grok delivers these envelopes two ways: as a JSON object, or — when it
	// wraps them in an MCP text block — as a JSON *string* (already flattened by
	// flattenMcpContent before we get here). Re-parse the string form so both
	// paths normalize identically.
	if (typeof output === "string") {
		const trimmed = output.trim();
		if (trimmed.startsWith("{") && ENVELOPE_SIGNATURE.test(trimmed)) {
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				const normalized = normalizeNativeToolResult(parsed);
				if (typeof normalized === "string") return normalized;
			} catch {
				// Not valid JSON after all — fall through and return the raw string.
			}
		}
		return output;
	}
	if (output === null || typeof output !== "object" || Array.isArray(output)) {
		return output;
	}
	const o = output as Record<string, unknown>;
	const type =
		typeof o["type"] === "string" ? (o["type"] as string).toLowerCase() : null;

	// list_dir → the indented tree string the tool already formatted.
	if (type === "listdir" || type === "list_dir" || type === "list_directory") {
		const container = o["Content"] ?? o["content"];
		if (container !== null && typeof container === "object") {
			const c = (container as Record<string, unknown>)["content"];
			if (typeof c === "string" && c.length > 0) return c;
		}
		if (typeof o["content"] === "string" && o["content"].length > 0) {
			return o["content"];
		}
	}

	// read_file → the file contents. Grok wraps them in a FileContent envelope.
	// `raw_output` is the clean file text; `content` is the same but with an
	// "N→" line-number marker per line that the CodeBlock gutter would
	// duplicate, so strip those when raw_output isn't present.
	if (type === "readfile" || type === "read_file" || "FileContent" in o) {
		const fc =
			o["FileContent"] !== null && typeof o["FileContent"] === "object"
				? (o["FileContent"] as Record<string, unknown>)
				: null;
		const rawOutput =
			fc !== null &&
			typeof fc["raw_output"] === "string" &&
			fc["raw_output"].length > 0
				? (fc["raw_output"] as string)
				: null;
		if (rawOutput !== null) return rawOutput;
		const marked =
			fc !== null && typeof fc["content"] === "string"
				? (fc["content"] as string)
				: typeof o["content"] === "string"
					? (o["content"] as string)
					: null;
		if (marked !== null) return stripLineMarkers(marked);
	}

	// grep / search → grouped "path \n \t line: content" text.
	if (
		type === "grepsearch" ||
		type === "grep_search" ||
		type === "grep" ||
		Array.isArray(o["file_matches"])
	) {
		const grep = buildGrepText(o);
		if (grep !== null) return grep;
	}

	// SearchReplace (edit) → a short summary. The diff itself is surfaced via
	// the canonical Edit input (see buildCanonicalInput); this is the fallback
	// for any path that renders the raw result instead of the Edit row.
	if (
		type === "searchreplace" ||
		type === "search_replace" ||
		"EditsApplied" in o
	) {
		const { filePath, edits } = extractSearchReplaceEdits(o);
		if (edits.length > 0) {
			const where = filePath !== null ? ` to ${filePath}` : "";
			return `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"}${where}.`;
		}
	}

	// Generic stdout/stderr envelope (shell-like tools), where Grok serialises
	// the streams as byte arrays. Decode + concatenate so the row shows real
	// terminal text instead of an array of char codes.
	if ("stdout" in o || "stderr" in o) {
		const out =
			decodeByteArray(o["stdout"]) ??
			(typeof o["stdout"] === "string" ? (o["stdout"] as string) : "");
		const err =
			decodeByteArray(o["stderr"]) ??
			(typeof o["stderr"] === "string" ? (o["stderr"] as string) : "");
		const combined = [out, err].filter((s) => s.length > 0).join("\n");
		if (combined.length > 0) return combined;
	}

	return output;
};

const extractOutput = (u: Record<string, unknown>): unknown => {
	const raw =
		u["output"] !== undefined
			? unwrap(u["output"])
			: // Cursor's spelling: `rawOutput.content` carries the actual result
				// payload (file contents for Read, command stdout for Bash, etc).
				u["rawOutput"] !== undefined
				? unwrap(u["rawOutput"])
				: u["content"] !== undefined
					? (flattenMcpContent(u["content"]) ?? u["content"])
					: u["result"] !== undefined
						? unwrap(u["result"])
						: null;
	return normalizeNativeToolResult(raw);
};

const extractErrorDetail = (u: Record<string, unknown>): string | null => {
	const fields = ["message", "error", "details", "data"] as const;
	for (const f of fields) {
		const v = u[f];
		if (typeof v === "string" && v.length > 0) return v;
		if (v !== null && typeof v === "object") {
			const nested = (v as Record<string, unknown>).message;
			if (typeof nested === "string" && nested.length > 0) return nested;
		}
	}
	return null;
};

const safeStringify = (u: Record<string, unknown>): string => {
	try {
		return JSON.stringify(u);
	} catch {
		return "(unserialisable)";
	}
};

/**
 * When extractToolName still returns the generic fallback "tool", dump the
 * full raw ACP update under the existing ACP debug flag so we can quickly
 * add the missing mapping on the next Grok (or Gemini/Cursor) release.
 * This directly implements the user's request for "add some logs".
 */
const logUnknownToolIfNeeded = (
	provider: AcpProviderTag,
	u: Record<string, unknown>,
	toolName: string,
	phase: string,
): void => {
	if (toolName !== "tool") return;
	if (!ACP_TRACE) return;
	trace(provider, `unknown tool ${phase} — raw payload=${safePreview(u, 800)}`);
};

/**
 * Whether the update kind contributes to an in-flight assistant message
 * burst. ACP streams text as many tiny `agent_message_chunk` frames
 * (sometimes mid-token, like `monore` + `po`); the renderer would render
 * each as its own bubble unless we coalesce. Anything else flushes the
 * buffer.
 */
const isAssistantTextChunk = (kind: string): boolean =>
	kind === "agent_message_chunk" || kind === "message";

/**
 * Whether the update kind is a streaming thinking/reasoning delta.
 * Grok (and other ACP agents) emit one token per `agent_thought_chunk` /
 * `thinking_chunk`. Without coalescing we would emit a separate Thinking
 * row for every word — exactly the bug the user reported.
 */
const isThinkingChunk = (kind: string): boolean =>
	kind === "agent_thought_chunk" ||
	kind === "agent_reasoning_chunk" ||
	kind === "thinking_chunk" ||
	kind === "reasoning";

interface AcpTranslator {
	/**
	 * Translate one ACP `session/update` payload. May return zero events
	 * (chunk got buffered for coalescing) or multiple (a flush of buffered
	 * assistant text plus the new event).
	 */
	translate(update: unknown): ReadonlyArray<AgentEvent>;
	/**
	 * Drain any buffered assistant text as a final `AssistantMessage` event.
	 * Call when the turn ends (`stopReason`) or the session closes so the
	 * last burst doesn't sit silently in memory.
	 */
	flush(): ReadonlyArray<AgentEvent>;
}

/**
 * Per-tool-call state we keep so we can dedupe events. ACP servers re-send
 * `tool_call_update` frames for the same id as a call progresses (pending →
 * in_progress → completed); without dedupe each update becomes its own row
 * in the renderer.
 */
interface ToolCallState {
	/** What we last emitted as `ToolUse.input` — used to skip identical re-emits. */
	lastInputJson: string | null;
	/** True once we've emitted a `ToolResult` for this call. */
	resultEmitted: boolean;
	/** True once we've emitted a `ToolUse` for this call. */
	useEmitted: boolean;
	/**
	 * Canonical tool name (e.g. "Read", "Edit") captured from the FIRST
	 * frame for this call. Cursor's `tool_call_update` frames carry no
	 * `kind` field, so without this we'd fall back to the generic "tool"
	 * label on every update and lose the input mapping (diff blocks etc).
	 */
	toolName: string | null;
}

interface CollabAgentRun {
	readonly parentItemId: AgentItemId;
	readonly model: string;
	readonly startedAt: number;
	turnCount: number;
	lastMessage: string;
	summaryEmitted: boolean;
}

interface GrokCursorTaskRun {
	readonly itemId: AgentItemId;
	readonly description: string;
	readonly prompt: string;
	readonly model: string;
	readonly startedAt: number;
	readonly scoreText: string;
	childEventCount: number;
	lastActivityAt: number;
	lastMessage: string;
	summaryEmitted: boolean;
}

const recordFrom = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const stringFrom = (
	record: Record<string, unknown>,
	key: string,
): string | null => {
	const v = record[key];
	return typeof v === "string" && v.length > 0 ? v : null;
};

const collabAgentStateStatus = (value: unknown): string | null => {
	const state = recordFrom(value);
	if (state === null) return null;
	const directType = stringFrom(state, "type");
	if (directType !== null) return directType;
	const status = state["status"];
	if (typeof status === "string") return status;
	if (status !== null && typeof status === "object") {
		return stringFrom(status as Record<string, unknown>, "type");
	}
	return null;
};

const collabAgentStateMessage = (value: unknown): string | null => {
	const state = recordFrom(value);
	if (state === null) return null;
	return stringFrom(state, "message");
};

const isTerminalCollabAgentStatus = (status: string | null): boolean =>
	status === "completed" ||
	status === "idle" ||
	status === "notLoaded" ||
	status === "errored" ||
	status === "systemError" ||
	status === "interrupted" ||
	status === "shutdown";

const grokCallPrefix = (itemId: string): string | null => {
	const match = /^call-([0-9a-f-]{36})-composer_call_/i.exec(itemId);
	return match?.[1] ?? null;
};

const isGrokCursorTaskInput = (
	input: unknown,
): input is Record<string, unknown> => {
	const record = recordFrom(input);
	if (record === null) return false;
	return (
		record["variant"] === "CursorTask" ||
		typeof record["subagent_type"] === "string"
	);
};

const grokTaskText = (
	input: Record<string, unknown>,
): {
	readonly description: string;
	readonly prompt: string;
	readonly model: string;
} => {
	const description =
		typeof input["description"] === "string" ? input["description"] : "agent";
	const prompt = typeof input["prompt"] === "string" ? input["prompt"] : "";
	const model = typeof input["model"] === "string" ? input["model"] : "inherit";
	return { description, prompt, model };
};

const GROK_TASK_STOP_WORDS = new Set([
	"about",
	"after",
	"again",
	"available",
	"check",
	"code",
	"current",
	"files",
	"from",
	"into",
	"local",
	"return",
	"status",
	"task",
	"tasks",
	"that",
	"this",
	"with",
	"work",
]);

const tokenizeForGrokTaskScore = (value: string): Set<string> => {
	const out = new Set<string>();
	for (const token of value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ??
		[]) {
		if (!GROK_TASK_STOP_WORDS.has(token)) out.add(token);
	}
	return out;
};

const scoreGrokTaskMatch = (task: GrokCursorTaskRun, text: string): number => {
	const haystack = text.toLowerCase();
	const description = task.description.toLowerCase();
	let score = haystack.includes(description) ? 20 : 0;
	const taskTokens = tokenizeForGrokTaskScore(task.scoreText);
	const eventTokens = tokenizeForGrokTaskScore(text);
	for (const token of eventTokens) {
		if (taskTokens.has(token)) score += 1;
	}
	return score;
};

const appendStreamText = (buffer: string, text: string): string => {
	if (
		buffer.length > 0 &&
		text.length > 0 &&
		/[A-Za-z0-9]$/.test(buffer) &&
		/^[A-Z][a-z]/.test(text)
	) {
		return `${buffer} ${text}`;
	}
	return `${buffer}${text}`;
};

/**
 * Create a per-session translator. Stateful because:
 *   1. ACP's `agent_message_chunk` is a delta protocol — we buffer
 *      consecutive chunks into one logical `AssistantMessage` event.
 *   2. `tool_call_update` is also a delta protocol — we dedupe so the
 *      renderer doesn't show a stack of "Read foo.ts" rows for one read.
 */
export const createAcpTranslator = (
	provider: AcpProviderTag,
): AcpTranslator => {
	// Buffer for the in-flight assistant message text. Reset to "" after
	// each flush.
	let assistantBuffer = "";
	let assistantItemId: AgentItemId | null = null;

	// Parallel buffer for thinking/reasoning chunks (Grok agent streams these
	// one token at a time). We coalesce them into a single Thinking event so
	// the UI shows one nice collapsible "Thinking" row instead of 20 one-word
	// rows.
	let thinkingBuffer = "";
	let thinkingItemId: AgentItemId | null = null;

	const toolStates = new Map<string, ToolCallState>();
	const collabAgentsByThread = new Map<string, CollabAgentRun>();
	const grokCursorTasks = new Map<AgentItemId, GrokCursorTaskRun>();
	const grokCursorTaskOrder: AgentItemId[] = [];
	const grokPrefixToTask = new Map<string, AgentItemId>();
	const grokTaskLaunchPrefixes = new Set<string>();
	let lastGrokCursorTextParentItemId: AgentItemId | undefined;

	const flushAssistant = (): ReadonlyArray<AgentEvent> => {
		if (assistantBuffer.length === 0) return [];
		const parentItemId = grokCursorTextParentFor(assistantBuffer);
		const ev: AgentEvent = {
			_tag: "AssistantMessage",
			itemId: assistantItemId ?? nextItemId(),
			text: assistantBuffer,
			parentItemId,
		};
		noteGrokCursorTaskChild(parentItemId, assistantBuffer);
		trace(
			provider,
			`flush AssistantMessage itemId=${ev.itemId} len=${assistantBuffer.length} preview=${safePreview(assistantBuffer)}`,
		);
		assistantBuffer = "";
		assistantItemId = null;
		return [ev];
	};

	const flushThinking = (): ReadonlyArray<AgentEvent> => {
		if (thinkingBuffer.length === 0) return [];
		const parentItemId = grokCursorTextParentFor(thinkingBuffer);
		const ev: AgentEvent = {
			_tag: "Thinking",
			itemId: thinkingItemId ?? nextItemId(),
			text: thinkingBuffer,
			redacted: false,
			parentItemId,
		};
		noteGrokCursorTaskChild(parentItemId);
		trace(
			provider,
			`flush Thinking itemId=${ev.itemId} len=${thinkingBuffer.length} preview=${safePreview(thinkingBuffer)}`,
		);
		thinkingBuffer = "";
		thinkingItemId = null;
		return [ev];
	};

	/**
	 * Drain any pending thinking + assistant text. Order: thinking first
	 * (the model usually emits reasoning before its final answer), then the
	 * assistant message. Used both on explicit flush() and before every
	 * non-streaming event.
	 */
	const flushPending = (): ReadonlyArray<AgentEvent> => {
		const t = flushThinking();
		const a = flushAssistant();
		return t.length === 0 ? a : a.length === 0 ? t : [...t, ...a];
	};

	const getOrInitToolState = (id: string): ToolCallState => {
		let s = toolStates.get(id);
		if (s === undefined) {
			s = {
				lastInputJson: null,
				resultEmitted: false,
				useEmitted: false,
				toolName: null,
			};
			toolStates.set(id, s);
		}
		return s;
	};

	const parentItemIdForThread = (threadId: unknown): AgentItemId | undefined =>
		typeof threadId === "string"
			? collabAgentsByThread.get(threadId)?.parentItemId
			: undefined;

	const rememberCollabAgent = (
		itemId: AgentItemId,
		threadId: string,
		model: string,
	): CollabAgentRun => {
		let run = collabAgentsByThread.get(threadId);
		if (run === undefined) {
			run = {
				parentItemId: itemId,
				model,
				startedAt: Date.now(),
				turnCount: 0,
				lastMessage: "",
				summaryEmitted: false,
			};
			collabAgentsByThread.set(threadId, run);
		}
		return run;
	};

	const maybeFinishCollabAgent = (
		itemId: AgentItemId,
		run: CollabAgentRun,
		state: unknown,
	): AgentEvent | null => {
		const status = collabAgentStateStatus(state);
		if (!isTerminalCollabAgentStatus(status) || run.summaryEmitted) return null;
		run.summaryEmitted = true;
		const message = collabAgentStateMessage(state) ?? run.lastMessage;
		return {
			_tag: "SubagentSummary",
			itemId,
			agentName: "agent",
			model: run.model,
			turns: run.turnCount,
			durationMs: Date.now() - run.startedAt,
			summary: message,
			isError: status === "errored" || status === "interrupted",
		};
	};

	const rememberGrokCursorTask = (
		itemId: AgentItemId,
		input: Record<string, unknown>,
	): void => {
		if (provider !== "grok" || !isGrokCursorTaskInput(input)) return;
		const current = grokCursorTasks.get(itemId);
		const { description, prompt, model } = grokTaskText(input);
		if (current !== undefined) {
			current.lastMessage = current.lastMessage || description;
			return;
		}
		grokCursorTasks.set(itemId, {
			itemId,
			description,
			prompt,
			model,
			startedAt: Date.now(),
			scoreText: `${description}\n${prompt}`,
			childEventCount: 0,
			lastActivityAt: Date.now(),
			lastMessage: "",
			summaryEmitted: false,
		});
		grokCursorTaskOrder.push(itemId);
		const prefix = grokCallPrefix(itemId);
		if (prefix !== null) grokTaskLaunchPrefixes.add(prefix);
	};

	const bestGrokCursorTaskForText = (
		text: string,
	): GrokCursorTaskRun | null => {
		if (provider !== "grok" || grokCursorTaskOrder.length === 0) return null;
		let best: GrokCursorTaskRun | null = null;
		let bestScore = 0;
		for (const itemId of grokCursorTaskOrder) {
			const task = grokCursorTasks.get(itemId);
			if (task === undefined || task.summaryEmitted) continue;
			const score = scoreGrokTaskMatch(task, text);
			if (score > bestScore) {
				best = task;
				bestScore = score;
			}
		}
		return bestScore > 0 ? best : null;
	};

	const grokCursorTextParentFor = (text: string): AgentItemId | undefined => {
		if (provider !== "grok") return undefined;
		const best = bestGrokCursorTaskForText(text);
		if (best !== null) return best.itemId;
		if (lastGrokCursorTextParentItemId === undefined) return undefined;
		const task = grokCursorTasks.get(lastGrokCursorTextParentItemId);
		return task !== undefined && !task.summaryEmitted ? task.itemId : undefined;
	};

	const parentGrokCursorTaskForTool = (
		itemId: AgentItemId,
		toolName: string,
		update: Record<string, unknown>,
		input: unknown,
	): AgentItemId | undefined => {
		if (provider !== "grok" || grokCursorTaskOrder.length === 0)
			return undefined;
		if (toolName === "Task" || toolName === "Agent") return undefined;
		const prefix = grokCallPrefix(itemId);
		if (prefix === null || grokTaskLaunchPrefixes.has(prefix)) return undefined;
		const existing = grokPrefixToTask.get(prefix);
		if (existing !== undefined) return existing;

		const rawInput = recordFrom(update["rawInput"]);
		const text = safeStringify({
			title: update["title"],
			kind: update["kind"],
			rawInput,
			input,
		});
		const task = bestGrokCursorTaskForText(text);
		if (task === null) return undefined;
		grokPrefixToTask.set(prefix, task.itemId);
		return task.itemId;
	};

	const noteGrokCursorTaskChild = (
		parentItemId: AgentItemId | undefined,
		message?: string,
	): void => {
		if (parentItemId === undefined) return;
		const task = grokCursorTasks.get(parentItemId);
		if (task === undefined) return;
		if (!task.summaryEmitted) {
			lastGrokCursorTextParentItemId = parentItemId;
		}
		task.childEventCount += 1;
		task.lastActivityAt = Date.now();
		if (message !== undefined && message.trim().length > 0) {
			task.lastMessage = message.trim();
		}
	};

	const finishGrokCursorTasks = (): ReadonlyArray<AgentEvent> => {
		if (provider !== "grok") return [];
		const events: AgentEvent[] = [];
		for (const itemId of grokCursorTaskOrder) {
			const task = grokCursorTasks.get(itemId);
			if (task === undefined || task.summaryEmitted) continue;
			task.summaryEmitted = true;
			events.push({
				_tag: "SubagentSummary",
				itemId: task.itemId,
				agentName: task.description,
				model: task.model,
				turns: task.childEventCount,
				durationMs: Math.max(0, task.lastActivityAt - task.startedAt),
				summary: task.lastMessage || "Completed.",
				isError: false,
			});
		}
		return events;
	};

	const translateOne = (update: unknown): ReadonlyArray<AgentEvent> => {
		if (update === null || typeof update !== "object") return [];
		const u = update as Record<string, unknown>;
		const wrappedItem = recordFrom(u["item"]);
		const kind =
			typeof u["sessionUpdate"] === "string"
				? (u["sessionUpdate"] as string)
				: typeof u["type"] === "string"
					? (u["type"] as string)
					: typeof wrappedItem?.["type"] === "string"
						? (wrappedItem["type"] as string)
						: typeof u["method"] === "string"
							? (u["method"] as string)
							: null;
		if (kind === null) return [];

		const shouldFlushBeforeEvent = !(
			provider === "grok" &&
			(kind === "tool_call_update" ||
				kind === "tool_result" ||
				kind === "tool_output" ||
				kind === "function_call_output" ||
				kind === "custom_tool_call_output" ||
				kind === "tool_search_output")
		);

		// 1. Thinking / reasoning delta — buffer (coalesce) exactly like assistant
		//    text. This is the fix for the "Thinking The user is asking if I can..."
		//    word-by-word explosion the user reported with Grok.
		if (isThinkingChunk(kind)) {
			const flushed = flushAssistant();
			let text = asText(u["content"]);
			if (text === null || text.length === 0) return flushed;
			// Grok often starts its first thinking chunk by literally echoing the
			// user prompt ("The user says: \"...\" First, the user's query...").
			// We aggressively strip this meta-reasoning prefix so the Thinking row
			// shows the agent's actual work instead of the prompt copy.
			if (provider === "grok" && thinkingBuffer.length === 0) {
				const cleaned = text
					.replace(/^the user (says|asked|wants|is asking)[^"]*"\s*/i, "")
					.replace(/^first, the user's query[^—-]*[-—]\s*/i, "")
					.trim();
				if (cleaned.length > 10) {
					text = cleaned;
				}
			}
			if (thinkingItemId === null) thinkingItemId = nextItemId();
			thinkingBuffer = appendStreamText(thinkingBuffer, text);
			trace(
				provider,
				`buffer thinking chunk len=${text.length} totalLen=${thinkingBuffer.length}`,
			);
			return flushed;
		}

		// 2. Assistant text delta — buffer, don't emit yet.
		if (isAssistantTextChunk(kind)) {
			const flushed = flushThinking();
			const text =
				kind === "message"
					? extractMessageText(u["content"])
					: asText(u["content"]);
			if (text === null || text.length === 0) return flushed;
			if (assistantItemId === null) assistantItemId = nextItemId();
			assistantBuffer = appendStreamText(assistantBuffer, text);
			trace(
				provider,
				`buffer message chunk len=${text.length} totalLen=${assistantBuffer.length}`,
			);
			return flushed;
		}

		// 3. Any other event: flush both pending thinking + assistant text first
		//    so the timeline order stays correct ("reasoning burst → next tool /
		//    final answer").
		const flushed = shouldFlushBeforeEvent ? flushPending() : [];

		const tail = ((): ReadonlyArray<AgentEvent> => {
			switch (kind) {
				case "agent_thought_chunk":
				case "agent_reasoning_chunk":
				case "thinking_chunk":
				case "reasoning": {
					const item = wrappedItem ?? u;
					const parentItemId = parentItemIdForThread(u["threadId"]);
					const summary = Array.isArray(item["summary"])
						? (item["summary"] as unknown[]).filter(
								(value): value is string => typeof value === "string",
							)
						: [];
					const content = Array.isArray(item["content"])
						? (item["content"] as unknown[]).filter(
								(value): value is string => typeof value === "string",
							)
						: [];
					const nestedText = [...summary, ...content].join("\n").trim();
					const text = nestedText || asText(u["content"]);
					if (text === null || text.length === 0) return [];
					trace(provider, `emit Thinking len=${text.length}`);
					return [
						{
							_tag: "Thinking",
							itemId: extractCallId(item),
							text,
							redacted: false,
							parentItemId,
						},
					];
				}

				case "tool_call":
				case "tool_use":
				case "function_call":
				case "custom_tool_call":
				case "tool_search_call":
				case "local_shell_call":
				case "web_search_call":
				case "image_generation_call": {
					const rawKind =
						typeof u["kind"] === "string" ? (u["kind"] as string) : null;
					// Gemini emits a `think` tool call to advertise an internal
					// thought — we already surface those via `thinking_chunk`,
					// so don't double-render as a tool row.
					if (provider === "gemini" && rawKind === "think") {
						trace(provider, `skip think tool_call`);
						return [];
					}

					const callId = extractCallId(u);
					const toolName = extractToolName(u);
					logUnknownToolIfNeeded(provider, u, toolName, "tool_call");
					const input = buildCanonicalInput(toolName, u);
					if (input !== null && typeof input === "object") {
						rememberGrokCursorTask(callId, input as Record<string, unknown>);
					}
					const parentItemId = parentGrokCursorTaskForTool(
						callId,
						toolName,
						u,
						input,
					);
					const inputJson = toolInputFingerprint(input);
					const state = getOrInitToolState(callId);
					// Pin the canonical tool name on first sight so later update
					// frames (which omit `kind` for Cursor) still resolve to the
					// right Edit/Read/Write/Bash branch in buildCanonicalInput.
					if (state.toolName === null) state.toolName = toolName;
					// Dedupe: if we already emitted ToolUse with this exact input,
					// skip. Happens when an ACP server sends the same `tool_call`
					// twice (some implementations do for pending/in_progress).
					if (state.useEmitted && state.lastInputJson === inputJson) {
						trace(
							provider,
							`skip duplicate tool_call id=${callId} tool=${toolName}`,
						);
						return [];
					}
					state.useEmitted = true;
					state.lastInputJson = inputJson;
					noteGrokCursorTaskChild(parentItemId);
					trace(
						provider,
						`emit ToolUse id=${callId} tool=${toolName} input=${safePreview(input)}`,
					);
					return [
						{
							_tag: "ToolUse",
							itemId: callId,
							tool: toolName,
							input,
							parentItemId,
						},
					];
				}

				// ACP sends `tool_call_update` frames to amend an in-flight call.
				// Three shapes we care about:
				//   - completed Read/Bash/Search → content carries result text
				//   - completed Edit → content carries a `diff` block (input)
				//   - status/title bump only → no new info
				// Dedupe carefully so progress updates don't stack rows in the
				// renderer: re-emit ToolUse only if the input meaningfully
				// changed (e.g. a diff arrived), and emit ToolResult once.
				case "tool_call_update": {
					const rawKind =
						typeof u["kind"] === "string" ? (u["kind"] as string) : null;
					if (provider === "gemini" && rawKind === "think") return [];
					const callId = extractCallId(u);
					const state = getOrInitToolState(callId);
					// Prefer the tool name captured from the original tool_call. Some
					// update frames carry no `kind`, so re-extracting would
					// collapse to the generic "tool" label and break the Edit/Read/…
					// input mapping in buildCanonicalInput.
					const updateToolName = extractToolName(u);
					const toolName =
						state.toolName !== null && state.toolName !== "tool"
							? state.toolName
							: updateToolName;
					if (state.toolName === null) state.toolName = toolName;
					logUnknownToolIfNeeded(provider, u, toolName, "tool_call_update");
					const input = buildCanonicalInput(toolName, u);
					if (input !== null && typeof input === "object") {
						rememberGrokCursorTask(callId, input as Record<string, unknown>);
					}
					const parentItemId = parentGrokCursorTaskForTool(
						callId,
						toolName,
						u,
						input,
					);
					const events: AgentEvent[] = [];

					// Re-emit ToolUse only when input changed substantively —
					// typically when a diff block first appears for an Edit. If the
					// input is identical to what we last emitted, skip.
					if (input !== null) {
						if (
							provider === "grok" &&
							(toolName === "Task" || toolName === "Agent") &&
							isGrokCursorTaskInput(input) &&
							state.useEmitted &&
							state.lastInputJson !== null &&
							state.lastInputJson.includes('"prompt"') &&
							!state.lastInputJson.includes('"description":"Task"')
						) {
							trace(
								provider,
								`skip duplicate CursorTask update id=${callId} tool=${toolName}`,
							);
							return events;
						}
						const inputJson = toolInputFingerprint(input);
						if (state.lastInputJson !== inputJson) {
							state.lastInputJson = inputJson;
							state.useEmitted = true;
							noteGrokCursorTaskChild(parentItemId);
							trace(
								provider,
								`emit ToolUse(update) id=${callId} tool=${toolName} input=${safePreview(input)}`,
							);
							events.push({
								_tag: "ToolUse",
								itemId: callId,
								tool: toolName,
								input,
								parentItemId,
							});
						} else {
							trace(
								provider,
								`skip duplicate tool_call_update id=${callId} tool=${toolName}`,
							);
						}
					}

					const content = u["content"];
					const hasContent =
						content !== undefined &&
						Array.isArray(content) &&
						(content as ReadonlyArray<unknown>).length > 0;
					const isDiffOnly = hasContent && extractDiffBlock(content) !== null;
					const status = typeof u["status"] === "string" ? u["status"] : null;
					const completed = status === "completed" || status === "failed";

					// Emit a ToolResult at most once per call. Triggers:
					//   - Non-diff content arrived (the actual result payload)
					//   - Status flipped to completed/failed (terminal — even if
					//     there's no content, the renderer needs to know the call
					//     finished so spinners stop).
					if (
						!state.resultEmitted &&
						((hasContent && !isDiffOnly) || completed)
					) {
						state.resultEmitted = true;
						const output = extractOutput(u);
						const isError =
							u["isError"] === true ||
							u["is_error"] === true ||
							status === "failed";
						trace(
							provider,
							`emit ToolResult id=${callId} tool=${toolName} status=${status ?? "(none)"} isError=${isError} output=${safePreview(output)}`,
						);
						events.push({
							_tag: "ToolResult",
							itemId: callId,
							output,
							isError,
							parentItemId,
						});
						noteGrokCursorTaskChild(parentItemId);
					} else if (state.resultEmitted) {
						trace(
							provider,
							`skip late tool_call_update id=${callId} (result already emitted)`,
						);
					}

					return events;
				}

				case "tool_result":
				case "tool_output":
				case "function_call_output":
				case "custom_tool_call_output":
				case "tool_search_output": {
					const callId = extractCallId(u);
					const state = getOrInitToolState(callId);
					if (state.resultEmitted) {
						trace(
							provider,
							`skip duplicate ${kind} id=${callId} (result already emitted)`,
						);
						return [];
					}
					state.resultEmitted = true;
					const isError = u["isError"] === true || u["is_error"] === true;
					const output = extractOutput(u);
					const parentItemId = parentGrokCursorTaskForTool(
						callId,
						state.toolName ?? extractToolName(u),
						u,
						u["input"] ?? u["arguments"] ?? null,
					);
					noteGrokCursorTaskChild(parentItemId);
					trace(
						provider,
						`emit ToolResult(${kind}) id=${callId} isError=${isError} output=${safePreview(output)}`,
					);
					return [
						{
							_tag: "ToolResult",
							itemId: callId,
							output,
							isError,
							parentItemId,
						},
					];
				}

				case "error":
				case "agent_error": {
					const detail = extractErrorDetail(u);
					const providerLabel = provider === "grok" ? "Grok" : "Gemini";
					const message =
						detail !== null
							? detail
							: (() => {
									const serialized = safeStringify(u);
									return serialized === "{}"
										? `${providerLabel} agent reported an error with no detail.`
										: `${providerLabel} agent error: ${serialized}`;
								})();
					return [{ _tag: "Error", message }];
				}

				case "agentMessage": {
					const item = wrappedItem ?? u;
					const parentItemId = parentItemIdForThread(u["threadId"]);
					const text = stringFrom(item, "text");
					if (parentItemId === undefined || text === null) return [];
					const itemId = extractCallId(item);
					const state = getOrInitToolState(itemId as string);
					if (state.useEmitted) return [];
					state.useEmitted = true;
					const threadId = stringFrom(u, "threadId");
					if (threadId !== null) {
						const run = collabAgentsByThread.get(threadId);
						if (run !== undefined) {
							run.turnCount += 1;
							run.lastMessage = text;
						}
					}
					return [
						{
							_tag: "AssistantMessage",
							itemId,
							text,
							parentItemId,
						},
					];
				}

				case "commandExecution": {
					const item = wrappedItem ?? u;
					const parentItemId = parentItemIdForThread(u["threadId"]);
					if (parentItemId === undefined) return [];
					const itemId = extractCallId(item);
					const command = stringFrom(item, "command") ?? "";
					const cwd = stringFrom(item, "cwd");
					const status = stringFrom(item, "status");
					const output = stringFrom(item, "aggregatedOutput") ?? "";
					const isTerminal =
						status === "completed" ||
						status === "failed" ||
						(item["exitCode"] !== null && item["exitCode"] !== undefined);
					const state = getOrInitToolState(itemId as string);
					const events: AgentEvent[] = [];
					if (!state.useEmitted) {
						state.useEmitted = true;
						events.push({
							_tag: "ToolUse",
							itemId,
							tool: "Bash",
							input: { command, ...(cwd !== null ? { cwd } : {}) },
							parentItemId,
						});
					}
					if (isTerminal && !state.resultEmitted) {
						state.resultEmitted = true;
						events.push({
							_tag: "ToolResult",
							itemId,
							output,
							isError:
								status === "failed" ||
								(typeof item["exitCode"] === "number" &&
									item["exitCode"] !== 0),
							parentItemId,
						});
					}
					return events;
				}

				case "fileChange": {
					const item = wrappedItem ?? u;
					const parentItemId = parentItemIdForThread(u["threadId"]);
					if (parentItemId === undefined) return [];
					const itemId = extractCallId(item);
					const status = stringFrom(item, "status");
					const state = getOrInitToolState(itemId as string);
					const events: AgentEvent[] = [];
					if (!state.useEmitted) {
						state.useEmitted = true;
						events.push({
							_tag: "ToolUse",
							itemId,
							tool: "Edit",
							input: { changes: item["changes"] ?? [] },
							parentItemId,
						});
					}
					if (
						status !== null &&
						status !== "pending" &&
						status !== "inProgress" &&
						!state.resultEmitted
					) {
						state.resultEmitted = true;
						events.push({
							_tag: "ToolResult",
							itemId,
							output: { status, changes: item["changes"] ?? [] },
							isError: status === "failed",
							parentItemId,
						});
					}
					return events;
				}

				case "mcpToolCall":
				case "dynamicToolCall": {
					const item = wrappedItem ?? u;
					const parentItemId = parentItemIdForThread(u["threadId"]);
					if (parentItemId === undefined) return [];
					const itemId = extractCallId(item);
					const status = stringFrom(item, "status");
					const namespace = stringFrom(item, "namespace");
					const server = stringFrom(item, "server");
					const tool = stringFrom(item, "tool") ?? "Tool";
					const toolName =
						namespace !== null
							? `${namespace}__${tool}`
							: server !== null
								? `${server}__${tool}`
								: tool;
					const state = getOrInitToolState(itemId as string);
					const events: AgentEvent[] = [];
					if (!state.useEmitted) {
						state.useEmitted = true;
						events.push({
							_tag: "ToolUse",
							itemId,
							tool: toolName,
							input: item["arguments"] ?? {},
							parentItemId,
						});
					}
					const terminal =
						status === "completed" ||
						status === "failed" ||
						(item["success"] !== null && item["success"] !== undefined);
					if (terminal && !state.resultEmitted) {
						state.resultEmitted = true;
						events.push({
							_tag: "ToolResult",
							itemId,
							output:
								item["result"] ?? item["contentItems"] ?? item["error"] ?? null,
							isError:
								status === "failed" ||
								item["success"] === false ||
								(item["error"] !== null && item["error"] !== undefined),
							parentItemId,
						});
					}
					return events;
				}

				case "thread/status/changed":
				case "thread/closed":
				case "turn/completed": {
					const threadId = stringFrom(u, "threadId");
					if (threadId === null) return [];
					const run = collabAgentsByThread.get(threadId);
					if (run === undefined) return [];

					const status =
						kind === "thread/closed"
							? "shutdown"
							: kind === "turn/completed"
								? "idle"
								: collabAgentStateStatus(u["status"]);
					if (!isTerminalCollabAgentStatus(status)) return [];
					const summary = maybeFinishCollabAgent(run.parentItemId, run, {
						status,
						message: run.lastMessage,
					});
					return summary === null ? [] : [summary];
				}

				case "available_commands_update":
				case "current_mode_update":
					return [];

				// --- Grok agent swarming (collab agents) support ---
				// The Grok Build ACP emits collabAgentToolCall ThreadItems (via session/update
				// or wrapped in item_started / item_completed notifications) when the main
				// agent uses spawnAgent / sendInput / closeAgent etc. to orchestrate 10+
				// parallel sub-agents. We surface them as first-class ToolUse rows so the
				// swarm activity is visible immediately; richer SwarmRow UI comes later.
				case "collabAgentToolCall": {
					// The payload may be the collab item directly or wrapped: { item: ThreadItem, threadId, ... }
					const candidate = wrappedItem ?? u;
					if (candidate["type"] !== "collabAgentToolCall") {
						return [];
					}

					const collab = candidate;
					const tool =
						typeof collab["tool"] === "string"
							? (collab["tool"] as string)
							: "unknown";
					const callId = extractCallId(collab);
					const status =
						typeof collab["status"] === "string"
							? (collab["status"] as string)
							: null;
					const receiverThreadIds = Array.isArray(collab["receiverThreadIds"])
						? (collab["receiverThreadIds"] as string[])
						: [];
					const prompt =
						typeof collab["prompt"] === "string"
							? (collab["prompt"] as string)
							: null;
					const model =
						typeof collab["model"] === "string"
							? (collab["model"] as string)
							: null;
					const agentsStates = (collab["agentsStates"] ?? {}) as Record<
						string,
						unknown
					>;
					const parentItemId = parentItemIdForThread(collab["senderThreadId"]);

					if (tool === "spawnAgent") {
						const input = {
							subagent_type: "agent",
							prompt: prompt ?? "",
							...(model !== null ? { model } : {}),
							receiverThreadIds,
						};
						const state = getOrInitToolState(callId);
						if (!state.useEmitted) {
							state.useEmitted = true;
							state.lastInputJson = JSON.stringify(input);
							state.toolName = "Agent";
							for (const threadId of receiverThreadIds) {
								rememberCollabAgent(callId, threadId, model ?? "inherit");
							}
							const events: AgentEvent[] = [
								{
									_tag: "ToolUse",
									itemId: callId,
									tool: "Agent",
									input,
									parentItemId,
								},
							];
							for (const threadId of receiverThreadIds) {
								const run = collabAgentsByThread.get(threadId);
								if (run === undefined) continue;
								const summary = maybeFinishCollabAgent(
									run.parentItemId,
									run,
									agentsStates[threadId],
								);
								if (summary !== null) events.push(summary);
							}
							return events;
						}
						return [];
					}

					const input: Record<string, unknown> = {
						tool,
						...(prompt ? { prompt } : {}),
						...(model ? { model } : {}),
						receiverThreadIds,
						agentsStates,
					};
					if (status) input["status"] = status;

					const state = getOrInitToolState(callId);
					const isTerminal = status === "completed" || status === "failed";
					const toolName = `Collab${tool.charAt(0).toUpperCase()}${tool.slice(1)}`;

					// Emit (or re-emit with richer input) on first sight and on terminal transitions
					// so the renderer row can show a final result panel with the ending agentsStates.
					if (!state.useEmitted || isTerminal) {
						state.useEmitted = true;
						state.lastInputJson = JSON.stringify(input);
						trace(
							provider,
							`emit CollabToolUse id=${callId} tool=${toolName} receivers=${receiverThreadIds.length} status=${status ?? ""}`,
						);
						const events: AgentEvent[] = [
							{
								_tag: "ToolUse",
								itemId: callId,
								tool: toolName,
								input,
								parentItemId,
							},
						];
						if (isTerminal) {
							// Surface a clean result so the row collapses / shows "done" state.
							events.push({
								_tag: "ToolResult",
								itemId: callId,
								output: { status, agentsStates },
								isError: status === "failed",
								parentItemId,
							});
							state.resultEmitted = true;
						}
						for (const [threadId, agentState] of Object.entries(agentsStates)) {
							const run = collabAgentsByThread.get(threadId);
							if (run === undefined) continue;
							const summary = maybeFinishCollabAgent(
								run.parentItemId,
								run,
								agentState,
							);
							if (summary !== null) events.push(summary);
						}
						return events;
					}

					// Intermediate state updates (agentsStates changing while running) — we can
					// optionally emit a non-intrusive result or just trace. For v1 we stay silent
					// to avoid spamming the timeline; the live states live in the initial row's input.
					trace(
						provider,
						`skip duplicate collab update id=${callId} tool=${tool}`,
					);
					return [];
				}

				default:
					trace(provider, `unknown kind=${kind} payload=${safePreview(u)}`);
					return [];
			}
		})();

		return flushed.length === 0 ? tail : [...flushed, ...tail];
	};

	return {
		translate: translateOne,
		flush: () => {
			const pending = flushPending();
			const finishedTasks = finishGrokCursorTasks();
			return finishedTasks.length === 0
				? pending
				: [...pending, ...finishedTasks];
		},
	};
};

/**
 * Convenience wrapper for callers that don't need stateful coalescing
 * (e.g. unit tests). Equivalent to calling `createAcpTranslator(...).
 * translate(update)` once then flushing — useful when each update is a
 * one-off and you want any buffered text emitted immediately.
 */
export const translateAcpSessionUpdate = (
	update: unknown,
	provider: AcpProviderTag,
): ReadonlyArray<AgentEvent> => {
	const t = createAcpTranslator(provider);
	return [...t.translate(update), ...t.flush()];
};
