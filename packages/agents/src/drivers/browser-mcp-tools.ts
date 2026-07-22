import type {
	BrowserCommand,
	BrowserCommandResult,
	BrowserOverlayShape,
	BrowserTarget,
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	RuntimeMode,
} from "@zuse/contracts";
import { getToolPolicy } from "../kernel/policy.ts";

import type { BrowserSend } from "./browser-tools.ts";
import {
	booleanProp,
	type JsonSchemaObject,
	numberProp,
	objectSchema,
	stringProp,
} from "./mcp-tool-schema.ts";

export const BROWSER_MCP_SERVER_NAME = "zuse";

type JsonObject = JsonSchemaObject;

const targetProp: JsonObject = {
	oneOf: [
		objectSchema({ kind: { const: "ref" }, ref: stringProp("Snapshot ref.") }, [
			"kind",
			"ref",
		]),
		objectSchema(
			{
				kind: { const: "role" },
				role: stringProp("Accessible role."),
				name: stringProp("Accessible name."),
				exact: booleanProp("Require an exact name match."),
			},
			["kind", "role"],
		),
		objectSchema(
			{
				kind: { const: "text" },
				text: stringProp("Visible text."),
				exact: booleanProp("Require an exact match."),
			},
			["kind", "text"],
		),
		objectSchema(
			{ kind: { const: "css" }, selector: stringProp("CSS selector.") },
			["kind", "selector"],
		),
		objectSchema(
			{
				kind: { const: "point" },
				x: numberProp("Viewport x coordinate."),
				y: numberProp("Viewport y coordinate."),
			},
			["kind", "x", "y"],
		),
	],
	description: "Semantic, CSS, snapshot-ref, or viewport-coordinate target.",
};

type McpText = { readonly type: "text"; readonly text: string };
type McpImage = {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: "image/png";
};

export type BrowserMcpToolResult = {
	readonly content: ReadonlyArray<McpText | McpImage>;
	readonly isError?: boolean;
};

export type BrowserMcpToolDef = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonObject;
};

export const BROWSER_MCP_TOOLS: ReadonlyArray<BrowserMcpToolDef> = [
	{
		name: "browser_navigate",
		description:
			"Open a URL in Zuse's visible in-app browser and wait for it to settle. Use this for JS apps, dev servers, dashboards, screenshots, and browser interactions.",
		inputSchema: objectSchema(
			{
				url: stringProp(
					"Absolute URL, localhost host/path, or an environment-relative path.",
				),
				readiness: { type: "string", enum: ["immediate", "dom-ready", "load"] },
				environmentPort: numberProp("Local environment server port."),
				environmentProtocol: { type: "string", enum: ["http", "https"] },
			},
			["url"],
		),
	},
	{
		name: "browser_status",
		description:
			"Report browser availability, page, viewport, recording, access, and protocol capabilities.",
		inputSchema: objectSchema({}),
	},
	{
		name: "browser_resize",
		description:
			"Resize the single visible browser surface using a responsive preset or custom dimensions.",
		inputSchema: objectSchema(
			{
				mode: {
					type: "string",
					enum: ["fill", "phone", "tablet", "laptop", "desktop", "custom"],
				},
				width: numberProp("Custom viewport width in CSS pixels.", 3840),
				height: numberProp("Custom viewport height in CSS pixels.", 2160),
				orientation: { type: "string", enum: ["portrait", "landscape"] },
				lockAspectRatio: booleanProp(
					"Keep the current aspect ratio during manual resizing.",
				),
			},
			["mode"],
		),
	},
	{
		name: "browser_screenshot",
		description:
			"Capture the visible browser viewport as a PNG image. Set fullPage to capture beyond the viewport when supported.",
		inputSchema: objectSchema({
			fullPage: booleanProp("Capture the entire scrollable page."),
		}),
	},
	{
		name: "browser_snapshot",
		description:
			"Return a compact accessibility-tree snapshot with refs. Use this before clicking, typing, selecting, or reading a specific element.",
		inputSchema: objectSchema({
			screenshot: { type: "string", enum: ["viewport", "full-page"] },
		}),
	},
	{
		name: "browser_click",
		description:
			"Click an element by ref from browser_snapshot. Requires approval unless full-access mode is active.",
		inputSchema: objectSchema({
			ref: stringProp("Element ref from browser_snapshot, e.g. e3."),
			target: targetProp,
			element: stringProp("Human-readable target description."),
		}),
	},
	{
		name: "browser_type",
		description:
			"Replace the value of an input/textarea by ref. Set submit to press Enter afterward. Prefer browser_fill_form for multiple fields.",
		inputSchema: objectSchema(
			{
				ref: stringProp("Element ref from browser_snapshot."),
				target: targetProp,
				text: stringProp("Text to type."),
				submit: booleanProp("Press Enter after typing."),
				element: stringProp("Human-readable field description."),
			},
			["text"],
		),
	},
	{
		name: "browser_wait",
		description:
			"Wait for a fixed delay, for a CSS selector, or for exact text to appear.",
		inputSchema: objectSchema({
			ms: numberProp("Fixed delay in milliseconds.", 15000),
			selector: stringProp("CSS selector to wait for."),
			text: stringProp("Exact visible text to wait for."),
			timeoutMs: numberProp("Selector/text timeout in milliseconds.", 25000),
		}),
	},
	{
		name: "browser_scroll",
		description:
			"Scroll the page up/down/top/bottom, or scroll a snapshot ref into view.",
		inputSchema: objectSchema({
			direction: {
				type: "string",
				enum: ["up", "down", "top", "bottom"],
			},
			ref: stringProp("Element ref to scroll into view."),
		}),
	},
	{
		name: "browser_hover",
		description: "Hover an element by ref to reveal menus or tooltips.",
		inputSchema: objectSchema(
			{ ref: stringProp("Element ref from browser_snapshot.") },
			["ref"],
		),
	},
	{
		name: "browser_select",
		description: "Choose an option in a select dropdown by ref.",
		inputSchema: objectSchema(
			{
				ref: stringProp("Select element ref from browser_snapshot."),
				value: stringProp("Option value or visible label."),
				element: stringProp("Human-readable dropdown description."),
			},
			["ref", "value"],
		),
	},
	{
		name: "browser_press",
		description:
			"Press a keyboard key on a ref, or on the currently focused element when ref is omitted.",
		inputSchema: objectSchema(
			{
				key: stringProp("Key name, e.g. Enter, Tab, Escape, ArrowDown."),
				ref: stringProp("Optional target element ref."),
				element: stringProp("Human-readable target description."),
			},
			["key"],
		),
	},
	{
		name: "browser_read",
		description: "Read visible text from the page, or from one element by ref.",
		inputSchema: objectSchema({
			ref: stringProp("Optional element ref from browser_snapshot."),
		}),
	},
	{
		name: "browser_history",
		description: "Go back, go forward, or reload the visible browser.",
		inputSchema: objectSchema(
			{ action: { type: "string", enum: ["back", "forward", "reload"] } },
			["action"],
		),
	},
	{
		name: "browser_console",
		description:
			"Read recent console messages, uncaught exceptions, load failures, and dialog state.",
		inputSchema: objectSchema({}),
	},
	{
		name: "browser_network",
		description:
			"List network requests since last load, or inspect one request by id.",
		inputSchema: objectSchema({
			filter: stringProp("Only list requests whose URL contains this text."),
			id: stringProp("Request id from a previous listing."),
		}),
	},
	{
		name: "browser_fill_form",
		description:
			"Fill several input/select fields by snapshot refs in one action. Requires approval unless full-access mode is active.",
		inputSchema: objectSchema(
			{
				fields: {
					type: "array",
					minItems: 1,
					items: objectSchema(
						{
							ref: stringProp("Field ref from browser_snapshot."),
							value: stringProp("Text, or select option value/label."),
							element: stringProp("Human-readable field description."),
						},
						["ref", "value"],
					),
				},
				submit: booleanProp("Press Enter in the last field after filling."),
			},
			["fields"],
		),
	},
	{
		name: "browser_dialog",
		description:
			"Accept or dismiss the currently open JavaScript alert/confirm/prompt dialog.",
		inputSchema: objectSchema(
			{
				action: { type: "string", enum: ["accept", "dismiss"] },
				promptText: stringProp("Text to enter when accepting a prompt()."),
			},
			["action"],
		),
	},
	{
		name: "browser_login",
		description:
			"Fill and submit saved dummy/test credentials for an origin. Always requires approval.",
		inputSchema: objectSchema(
			{ origin: stringProp("Site origin, e.g. https://app.example.com.") },
			["origin"],
		),
	},
	{
		name: "browser_wait_for",
		description:
			"Wait until every supplied semantic, selector, text, URL, loading, and delay condition passes within one timeout.",
		inputSchema: objectSchema({
			target: targetProp,
			selector: stringProp("CSS selector that must exist and be visible."),
			text: stringProp("Visible text that must appear."),
			urlIncludes: stringProp("Substring required in the current URL."),
			loadingComplete: booleanProp("Require document loading to complete."),
			ms: numberProp("Minimum delay in milliseconds.", 15000),
			timeoutMs: numberProp("Overall timeout in milliseconds.", 25000),
		}),
	},
	{
		name: "browser_inspect",
		description:
			"Inspect one unambiguous target: attributes, accessible state, styles, box model, selector hints, and geometry.",
		inputSchema: objectSchema({ target: targetProp }, ["target"]),
	},
	{
		name: "browser_evaluate",
		description:
			"Evaluate bounded JavaScript in the page. Always requires explicit approval; results must be JSON serializable.",
		inputSchema: objectSchema(
			{
				expression: stringProp("JavaScript expression, up to 64 KiB."),
				awaitPromise: booleanProp("Await a returned promise."),
			},
			["expression"],
		),
	},
	{
		name: "browser_recording_start",
		description:
			"Start recording the visible browser surface, agent cursor, and annotations.",
		inputSchema: objectSchema({}),
	},
	{
		name: "browser_recording_stop",
		description:
			"Stop the active recording and return compact artifact metadata.",
		inputSchema: objectSchema({}),
	},
	{
		name: "browser_overlay",
		description:
			"Add, remove, undo, redo, or clear non-destructive browser overlay marks.",
		inputSchema: objectSchema(
			{
				action: {
					type: "string",
					enum: ["add", "remove", "undo", "redo", "clear"],
				},
				id: stringProp("Shape id for removal."),
				shape: {
					type: "object",
					description:
						"Tagged rectangle, highlight, arrow, label, or freehand shape.",
				},
			},
			["action"],
		),
	},
];

export const browserMcpPromptHint = (): string => {
	const signature = (tool: BrowserMcpToolDef): string => {
		const properties =
			(tool.inputSchema["properties"] as Record<string, unknown> | undefined) ??
			{};
		const required = new Set(
			(tool.inputSchema["required"] as ReadonlyArray<string> | undefined) ?? [],
		);
		const args = Object.keys(properties)
			.map((key) => (required.has(key) ? key : `${key}?`))
			.join(",");
		return `${tool.name}{${args}}`;
	};
	return [
		"<zuse-browser-tools>",
		`The "${BROWSER_MCP_SERVER_NAME}" MCP server controls Zuse's visible in-app browser. Call its tools directly via MCP (server name "${BROWSER_MCP_SERVER_NAME}") — do NOT search the filesystem for tool schemas or descriptor files.`,
		`Tools: ${BROWSER_MCP_TOOLS.map(signature).join(", ")}.`,
		"Typical flow: browser_navigate → browser_snapshot (a11y tree with refs; read it before clicking/typing) → act by ref → browser_console/browser_network to verify.",
		"</zuse-browser-tools>",
	].join("\n");
};

const READ_ONLY_BROWSER_TOOLS = new Set([
	"browser_status",
	"browser_navigate",
	"browser_screenshot",
	"browser_snapshot",
	"browser_wait",
	"browser_scroll",
	"browser_hover",
	"browser_read",
	"browser_history",
	"browser_console",
	"browser_network",
	"browser_wait_for",
	"browser_inspect",
]);

const text = (value: string, isError = false): BrowserMcpToolResult => ({
	content: [{ type: "text", text: value }],
	...(isError ? { isError: true } : {}),
});

const asString = (
	args: JsonObject,
	key: string,
	required = false,
): string | undefined => {
	const value = args[key];
	if (typeof value === "string" && value.length > 0) return value;
	if (required) throw new Error(`Missing ${key}.`);
	return undefined;
};

const asBoolean = (args: JsonObject, key: string): boolean | undefined =>
	typeof args[key] === "boolean" ? (args[key] as boolean) : undefined;

const asNumber = (args: JsonObject, key: string): number | undefined =>
	typeof args[key] === "number" && Number.isFinite(args[key])
		? (args[key] as number)
		: undefined;

const asTarget = (
	value: unknown,
	required = false,
): BrowserTarget | undefined => {
	if (value === null || typeof value !== "object") {
		if (required) throw new Error("Missing target.");
		return undefined;
	}
	const raw = value as JsonObject;
	const kind = asString(raw, "kind", true)!;
	switch (kind) {
		case "ref":
			return { _tag: "Ref", ref: asString(raw, "ref", true)! };
		case "role":
			return {
				_tag: "Role",
				role: asString(raw, "role", true)!,
				...(asString(raw, "name") !== undefined
					? { name: asString(raw, "name") }
					: {}),
				...(asBoolean(raw, "exact") !== undefined
					? { exact: asBoolean(raw, "exact") }
					: {}),
			};
		case "text":
			return {
				_tag: "Text",
				text: asString(raw, "text", true)!,
				...(asBoolean(raw, "exact") !== undefined
					? { exact: asBoolean(raw, "exact") }
					: {}),
			};
		case "css":
			return { _tag: "Css", selector: asString(raw, "selector", true)! };
		case "point":
			return {
				_tag: "Point",
				x: asNumber(raw, "x") ?? 0,
				y: asNumber(raw, "y") ?? 0,
			};
		default:
			throw new Error("target.kind must be ref, role, text, css, or point.");
	}
};

const commandFor = (name: string, args: JsonObject): BrowserCommand => {
	switch (name) {
		case "browser_navigate":
			return {
				_tag: "Navigate",
				url: asString(args, "url", true)!,
				...(asString(args, "readiness") !== undefined
					? {
							readiness: asString(args, "readiness") as
								| "immediate"
								| "dom-ready"
								| "load",
						}
					: {}),
				...(asNumber(args, "environmentPort") !== undefined
					? { environmentPort: asNumber(args, "environmentPort") }
					: {}),
				...(asString(args, "environmentProtocol") !== undefined
					? {
							environmentProtocol: asString(args, "environmentProtocol") as
								| "http"
								| "https",
						}
					: {}),
			};
		case "browser_status":
			return { _tag: "Status" };
		case "browser_resize":
			return {
				_tag: "Resize",
				mode: asString(args, "mode", true)! as
					| "fill"
					| "phone"
					| "tablet"
					| "laptop"
					| "desktop"
					| "custom",
				...(asNumber(args, "width") !== undefined
					? { width: asNumber(args, "width") }
					: {}),
				...(asNumber(args, "height") !== undefined
					? { height: asNumber(args, "height") }
					: {}),
				...(asString(args, "orientation") !== undefined
					? {
							orientation: asString(args, "orientation") as
								| "portrait"
								| "landscape",
						}
					: {}),
				...(asBoolean(args, "lockAspectRatio") !== undefined
					? { lockAspectRatio: asBoolean(args, "lockAspectRatio") }
					: {}),
			};
		case "browser_screenshot":
			return {
				_tag: "Screenshot",
				...(asBoolean(args, "fullPage") !== undefined
					? { fullPage: asBoolean(args, "fullPage") }
					: {}),
			};
		case "browser_snapshot":
			return {
				_tag: "Snapshot",
				...(asString(args, "screenshot") !== undefined
					? {
							screenshot: asString(args, "screenshot") as
								| "viewport"
								| "full-page",
						}
					: {}),
			};
		case "browser_click":
			return {
				_tag: "Click",
				...(asString(args, "ref") !== undefined
					? { ref: asString(args, "ref") }
					: {}),
				...(asTarget(args["target"]) !== undefined
					? { target: asTarget(args["target"]) }
					: {}),
			};
		case "browser_type":
			return {
				_tag: "Type",
				...(asString(args, "ref") !== undefined
					? { ref: asString(args, "ref") }
					: {}),
				...(asTarget(args["target"]) !== undefined
					? { target: asTarget(args["target"]) }
					: {}),
				text: asString(args, "text", true)!,
				...(asBoolean(args, "submit") !== undefined
					? { submit: asBoolean(args, "submit") }
					: {}),
			};
		case "browser_wait":
			return {
				_tag: "Wait",
				...(asNumber(args, "ms") !== undefined
					? { ms: asNumber(args, "ms") }
					: {}),
				...(asString(args, "selector") !== undefined
					? { selector: asString(args, "selector") }
					: {}),
				...(asString(args, "text") !== undefined
					? { text: asString(args, "text") }
					: {}),
				...(asNumber(args, "timeoutMs") !== undefined
					? { timeoutMs: asNumber(args, "timeoutMs") }
					: {}),
			};
		case "browser_scroll": {
			const direction = asString(args, "direction");
			if (
				direction !== undefined &&
				!["up", "down", "top", "bottom"].includes(direction)
			) {
				throw new Error("direction must be up, down, top, or bottom.");
			}
			return {
				_tag: "Scroll",
				...(direction !== undefined
					? { direction: direction as "up" | "down" | "top" | "bottom" }
					: {}),
				...(asString(args, "ref") !== undefined
					? { ref: asString(args, "ref") }
					: {}),
			};
		}
		case "browser_hover":
			return { _tag: "Hover", ref: asString(args, "ref", true)! };
		case "browser_select":
			return {
				_tag: "Select",
				ref: asString(args, "ref", true)!,
				value: asString(args, "value", true)!,
			};
		case "browser_press":
			return {
				_tag: "Press",
				key: asString(args, "key", true)!,
				...(asString(args, "ref") !== undefined
					? { ref: asString(args, "ref") }
					: {}),
			};
		case "browser_read":
			return {
				_tag: "Read",
				...(asString(args, "ref") !== undefined
					? { ref: asString(args, "ref") }
					: {}),
			};
		case "browser_history": {
			const action = asString(args, "action", true)!;
			if (!["back", "forward", "reload"].includes(action)) {
				throw new Error("action must be back, forward, or reload.");
			}
			return {
				_tag: "History",
				action: action as "back" | "forward" | "reload",
			};
		}
		case "browser_console":
			return { _tag: "Console" };
		case "browser_network":
			return {
				_tag: "Network",
				...(asString(args, "filter") !== undefined
					? { filter: asString(args, "filter") }
					: {}),
				...(asString(args, "id") !== undefined
					? { id: asString(args, "id") }
					: {}),
			};
		case "browser_fill_form": {
			const rawFields = args["fields"];
			if (!Array.isArray(rawFields) || rawFields.length === 0) {
				throw new Error("fields must be a non-empty array.");
			}
			return {
				_tag: "FillForm",
				fields: rawFields.map((field) => {
					if (field === null || typeof field !== "object") {
						throw new Error("Each field must be an object.");
					}
					const f = field as JsonObject;
					return {
						ref: asString(f, "ref", true)!,
						value: asString(f, "value", true)!,
					};
				}),
				...(asBoolean(args, "submit") !== undefined
					? { submit: asBoolean(args, "submit") }
					: {}),
			};
		}
		case "browser_dialog": {
			const action = asString(args, "action", true)!;
			if (action !== "accept" && action !== "dismiss") {
				throw new Error("action must be accept or dismiss.");
			}
			return {
				_tag: "Dialog",
				action,
				...(asString(args, "promptText") !== undefined
					? { promptText: asString(args, "promptText") }
					: {}),
			};
		}
		case "browser_login":
			return { _tag: "Login", origin: asString(args, "origin", true)! };
		case "browser_wait_for":
			return {
				_tag: "WaitFor",
				...(asTarget(args["target"]) !== undefined
					? { target: asTarget(args["target"]) }
					: {}),
				...(asString(args, "selector") !== undefined
					? { selector: asString(args, "selector") }
					: {}),
				...(asString(args, "text") !== undefined
					? { text: asString(args, "text") }
					: {}),
				...(asString(args, "urlIncludes") !== undefined
					? { urlIncludes: asString(args, "urlIncludes") }
					: {}),
				...(asBoolean(args, "loadingComplete") !== undefined
					? { loadingComplete: asBoolean(args, "loadingComplete") }
					: {}),
				...(asNumber(args, "ms") !== undefined
					? { ms: asNumber(args, "ms") }
					: {}),
				...(asNumber(args, "timeoutMs") !== undefined
					? { timeoutMs: asNumber(args, "timeoutMs") }
					: {}),
			};
		case "browser_inspect":
			return { _tag: "Inspect", target: asTarget(args["target"], true)! };
		case "browser_evaluate":
			return {
				_tag: "Evaluate",
				expression: asString(args, "expression", true)!,
				...(asBoolean(args, "awaitPromise") !== undefined
					? { awaitPromise: asBoolean(args, "awaitPromise") }
					: {}),
			};
		case "browser_recording_start":
			return { _tag: "RecordingStart" };
		case "browser_recording_stop":
			return { _tag: "RecordingStop" };
		case "browser_overlay": {
			const action = asString(args, "action", true)! as
				| "add"
				| "remove"
				| "undo"
				| "redo"
				| "clear";
			return {
				_tag: "Overlay",
				action,
				...(asString(args, "id") !== undefined
					? { id: asString(args, "id") }
					: {}),
				...(args["shape"] !== undefined
					? { shape: args["shape"] as BrowserOverlayShape }
					: {}),
			};
		}
		default:
			throw new Error(`Unknown browser tool: ${name}`);
	}
};

const resultFor = (
	name: string,
	args: JsonObject,
	result: BrowserCommandResult,
): BrowserMcpToolResult => {
	if (!result.ok) {
		return text(result.error ?? "Browser action failed.", true);
	}
	switch (name) {
		case "browser_navigate": {
			const title = result.title ?? "";
			return text(
				`Loaded ${result.url ?? asString(args, "url") ?? ""}${title.length > 0 ? ` - "${title}"` : ""}.`,
			);
		}
		case "browser_screenshot":
			return result.screenshot !== undefined
				? {
						content: [
							{ type: "image", data: result.screenshot, mimeType: "image/png" },
						],
					}
				: text("Could not capture a screenshot.", true);
		case "browser_snapshot":
			return text(
				result.payload === undefined
					? (result.snapshot ?? "[]")
					: JSON.stringify(result.payload, null, 2),
			);
		case "browser_status":
		case "browser_resize":
		case "browser_wait_for":
		case "browser_inspect":
		case "browser_evaluate":
		case "browser_recording_start":
		case "browser_recording_stop":
		case "browser_overlay":
			return text(
				JSON.stringify(
					result.payload ?? { detail: result.detail ?? "Done." },
					null,
					2,
				),
			);
		case "browser_read":
		case "browser_console":
		case "browser_network":
			return text(result.text ?? "");
		default:
			return text(result.detail ?? "Done.");
	}
};

const permissionSummary = (name: string, args: JsonObject): string => {
	const element = asString(args, "element");
	switch (name) {
		case "browser_click":
			return `Click ${element ?? asString(args, "ref") ?? "an element"}`;
		case "browser_type":
			return `Type into ${element ?? asString(args, "ref") ?? "a field"}`;
		case "browser_select":
			return `Select ${asString(args, "value") ?? "an option"} in ${
				element ?? asString(args, "ref") ?? "a dropdown"
			}`;
		case "browser_press":
			return `Press ${asString(args, "key") ?? "a key"}${
				element !== undefined ? ` on ${element}` : ""
			}`;
		case "browser_fill_form":
			return `Fill ${Array.isArray(args["fields"]) ? args["fields"].length : "a"} browser form field(s)`;
		case "browser_dialog":
			return `${asString(args, "action") ?? "Resolve"} browser dialog`;
		case "browser_login":
			return `Submit saved dummy login for ${asString(args, "origin") ?? "origin"}`;
		default:
			return name;
	}
};

export interface BrowserMcpToolOptions {
	readonly send: BrowserSend;
	readonly requestPermission: (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
}

export const ensureBrowserPermission = async (
	name: string,
	args: JsonObject,
	opts: BrowserMcpToolOptions,
): Promise<void> => {
	if (READ_ONLY_BROWSER_TOOLS.has(name)) return;

	const policy = getToolPolicy(
		"other",
		opts.getRuntimeMode(),
		opts.getPermissionMode(),
	);
	if (policy.kind === "auto-deny") {
		throw new Error(`Browser action blocked in plan mode: ${name}.`);
	}

	const forcePrompt = name === "browser_login" || name === "browser_evaluate";
	if (!forcePrompt && policy.kind === "auto-allow") return;

	const decision = await opts.requestPermission(
		{
			_tag: "Other",
			tool: name,
			summary: permissionSummary(name, args),
		},
		{ forcePrompt },
	);
	if (decision._tag === "Deny") {
		throw new Error(`Permission denied for ${name}.`);
	}
};

export const handleBrowserTool = async (
	name: string,
	args: JsonObject,
	opts: BrowserMcpToolOptions,
): Promise<BrowserMcpToolResult> => {
	await ensureBrowserPermission(name, args, opts);
	const command = commandFor(name, args);
	const result = await opts.send(command);
	return resultFor(name, args, result);
};
