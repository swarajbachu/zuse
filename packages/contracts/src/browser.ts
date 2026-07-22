import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { SessionId } from "./session.ts";

export {
	BrowserOverlayShape,
	BrowserViewportMode,
} from "./browser-shared.ts";

import { BrowserOverlayShape, BrowserViewportMode } from "./browser-shared.ts";

export const BrowserTarget = Schema.Union([
	Schema.TaggedStruct("Ref", { ref: Schema.String }),
	Schema.TaggedStruct("Role", {
		role: Schema.String,
		name: Schema.optional(Schema.String),
		exact: Schema.optional(Schema.Boolean),
	}),
	Schema.TaggedStruct("Text", {
		text: Schema.String,
		exact: Schema.optional(Schema.Boolean),
	}),
	Schema.TaggedStruct("Css", { selector: Schema.String }),
	Schema.TaggedStruct("Point", { x: Schema.Number, y: Schema.Number }),
]);
export type BrowserTarget = typeof BrowserTarget.Type;

export const BrowserReadiness = Schema.Literals([
	"immediate",
	"dom-ready",
	"load",
]);
export type BrowserReadiness = typeof BrowserReadiness.Type;

/**
 * In-app agent browser bridge.
 *
 * MCP tools run in the server process; the `<webview>` lives in the renderer.
 * So every agent browser action round-trips server → renderer → server,
 * mirroring `permission.ts`: the server broadcasts a `BrowserCommandRequest`
 * on `browser.commands`, the renderer drives the webview, and posts the
 * outcome back via `browser.respond`, which resolves a server-side Deferred.
 *
 * Every capability is a union member here — a wire change, never a
 * stringly-typed addition. v2 members (FillForm/Network/Dialog + the Wait and
 * Screenshot extensions) ride the same request/respond round-trip as v1.
 */
export const BrowserCommand = Schema.Union([
	/** Load a URL into the shared in-app webview and wait for it to settle. */
	Schema.TaggedStruct("Navigate", {
		url: Schema.String,
		readiness: Schema.optional(BrowserReadiness),
		environmentPort: Schema.optional(Schema.Number),
		environmentProtocol: Schema.optional(Schema.Literals(["http", "https"])),
	}),
	Schema.TaggedStruct("Status", {}),
	Schema.TaggedStruct("Resize", {
		mode: BrowserViewportMode,
		width: Schema.optional(Schema.Number),
		height: Schema.optional(Schema.Number),
		orientation: Schema.optional(Schema.Literals(["portrait", "landscape"])),
		lockAspectRatio: Schema.optional(Schema.Boolean),
	}),
	/**
	 * Capture the page. Default is the visible viewport via `capturePage`;
	 * `fullPage` captures beyond the viewport through CDP
	 * (`Page.captureScreenshot`) when the debugger is attached.
	 */
	Schema.TaggedStruct("Screenshot", {
		fullPage: Schema.optional(Schema.Boolean),
	}),
	/**
	 * Snapshot the page for targeting. v2: the renderer prefers a pruned
	 * accessibility tree over CDP (roles/names/states, interactive elements
	 * carrying `ref=eN` mapped to backendNodeIds renderer-side) and falls back
	 * to v1's injected DOM walk when CDP isn't attached. Cheaper for the model
	 * than a screenshot and robust to scroll/DPI.
	 */
	Schema.TaggedStruct("Snapshot", {
		screenshot: Schema.optional(Schema.Literals(["viewport", "full-page"])),
	}),
	/** Click the element carrying this snapshot `ref`. */
	Schema.TaggedStruct("Click", {
		ref: Schema.optional(Schema.String),
		target: Schema.optional(BrowserTarget),
	}),
	/**
	 * Type into the element with this `ref`. `submit` presses Enter afterward
	 * (e.g. to submit a search box / login form).
	 */
	Schema.TaggedStruct("Type", {
		ref: Schema.optional(Schema.String),
		target: Schema.optional(BrowserTarget),
		text: Schema.String,
		submit: Schema.optional(Schema.Boolean),
	}),
	/**
	 * Settle after navigation/AJAX. Wait a fixed `ms`, poll until a CSS
	 * `selector` appears, or poll until `text` shows up in the page's visible
	 * text (selector wins over text; either wins over ms). `timeoutMs` bounds
	 * the poll — capped renderer-side below the bridge's 30s deadline so a
	 * hopeless wait fails as a clean tool error, not a bridge timeout.
	 */
	Schema.TaggedStruct("Wait", {
		ms: Schema.optional(Schema.Number),
		selector: Schema.optional(Schema.String),
		text: Schema.optional(Schema.String),
		timeoutMs: Schema.optional(Schema.Number),
	}),
	Schema.TaggedStruct("WaitFor", {
		target: Schema.optional(BrowserTarget),
		selector: Schema.optional(Schema.String),
		text: Schema.optional(Schema.String),
		urlIncludes: Schema.optional(Schema.String),
		loadingComplete: Schema.optional(Schema.Boolean),
		ms: Schema.optional(Schema.Number),
		timeoutMs: Schema.optional(Schema.Number),
	}),
	/**
	 * Scroll the page (or a `ref` into view). `direction` moves the viewport;
	 * `ref` (when given) scrolls that element to center instead.
	 */
	Schema.TaggedStruct("Scroll", {
		direction: Schema.optional(
			Schema.Literals(["up", "down", "top", "bottom"]),
		),
		ref: Schema.optional(Schema.String),
	}),
	/** Hover an element by `ref` (reveal menus / tooltips). */
	Schema.TaggedStruct("Hover", { ref: Schema.String }),
	/** Choose an option in a <select> by `ref`, matching value or visible label. */
	Schema.TaggedStruct("Select", { ref: Schema.String, value: Schema.String }),
	/**
	 * Press a key (Enter, Tab, Escape, ArrowDown, …) on the element `ref`, or on
	 * whatever is focused when `ref` is omitted.
	 */
	Schema.TaggedStruct("Press", {
		key: Schema.String,
		ref: Schema.optional(Schema.String),
	}),
	/**
	 * Read the visible text of the page, or of one element when `ref` is given.
	 * Cheaper than a screenshot for confirming content / verifying a flow.
	 */
	Schema.TaggedStruct("Read", { ref: Schema.optional(Schema.String) }),
	/** Browser history / reload — back, forward, or reload the current page. */
	Schema.TaggedStruct("History", {
		action: Schema.Literals(["back", "forward", "reload"]),
	}),
	/** Return recent console messages + page errors captured since last load. */
	Schema.TaggedStruct("Console", {}),
	/**
	 * Fill several fields in one round-trip — inputs/textareas and <select>s by
	 * snapshot `ref`. One permission prompt covers the whole form. `submit`
	 * presses Enter in the last filled field afterward.
	 */
	Schema.TaggedStruct("FillForm", {
		fields: Schema.Array(
			Schema.Struct({
				ref: Schema.String,
				value: Schema.String,
			}),
		),
		submit: Schema.optional(Schema.Boolean),
	}),
	/**
	 * Network activity captured since the last page load (CDP Network domain,
	 * buffered in main). No `id` → compact request list, optionally substring-
	 * filtered by `filter`. With `id` → one request's detail incl. response
	 * headers and a truncated body.
	 */
	Schema.TaggedStruct("Network", {
		filter: Schema.optional(Schema.String),
		id: Schema.optional(Schema.String),
	}),
	/**
	 * Resolve the pending JavaScript dialog (alert/confirm/prompt/beforeunload)
	 * via `Page.handleJavaScriptDialog`. `promptText` answers a prompt() when
	 * accepting. Fails cleanly when no dialog is open.
	 */
	Schema.TaggedStruct("Dialog", {
		action: Schema.Literals(["accept", "dismiss"]),
		promptText: Schema.optional(Schema.String),
	}),
	/**
	 * Autofill + submit the saved (DUMMY/TEST) credentials for this origin.
	 * SECURITY: the command carries ONLY the origin — never the password. The
	 * renderer pulls the secret out-of-band via `browser.fillForOrigin` and
	 * injects it into the page, so the password never enters the agent's tool
	 * args/results or the LLM context.
	 */
	Schema.TaggedStruct("Login", { origin: Schema.String }),
	Schema.TaggedStruct("Inspect", { target: BrowserTarget }),
	Schema.TaggedStruct("Evaluate", {
		expression: Schema.String,
		awaitPromise: Schema.optional(Schema.Boolean),
	}),
	Schema.TaggedStruct("RecordingStart", {}),
	Schema.TaggedStruct("RecordingStop", {}),
	Schema.TaggedStruct("Overlay", {
		action: Schema.Literals(["add", "remove", "undo", "redo", "clear"]),
		shape: Schema.optional(BrowserOverlayShape),
		id: Schema.optional(Schema.String),
	}),
]);
export type BrowserCommand = typeof BrowserCommand.Type;

/**
 * Renderer-visible summary of a saved browser credential. Deliberately omits
 * the password — the settings UI only ever sees the origin + username, mirroring
 * the `hasApiKey` boolean exposure for provider API keys.
 */
export class BrowserCredentialSummary extends Schema.Class<BrowserCredentialSummary>(
	"BrowserCredentialSummary",
)({
	origin: Schema.String,
	username: Schema.String,
}) {}

/**
 * The actual secret, returned ONLY to the trusted renderer executor when it
 * handles a `Login` command. Never flows through the agent event stream, a
 * tool result, or the command broadcast.
 */
export class BrowserCredentialSecret extends Schema.Class<BrowserCredentialSecret>(
	"BrowserCredentialSecret",
)({
	username: Schema.String,
	password: Schema.String,
}) {}

/**
 * One outstanding command. `id` is the server-minted handle the renderer
 * echoes back on `browser.respond`. `sessionId` is the agent session that
 * issued it — the renderer uses it only for display/attribution today.
 */
export class BrowserCommandRequest extends Schema.Class<BrowserCommandRequest>(
	"BrowserCommandRequest",
)({
	id: Schema.String,
	sessionId: SessionId,
	command: BrowserCommand,
}) {}

/**
 * Renderer's reply for one command. `ok=false` carries a human-readable
 * `error` the tool surfaces to the agent. Successful results fill the
 * command-specific optional fields:
 *   - Navigate   → `url`, `title`
 *   - Screenshot → `screenshot` (base64 PNG, no data-URL prefix)
 */
export class BrowserCommandResult extends Schema.Class<BrowserCommandResult>(
	"BrowserCommandResult",
)({
	id: Schema.String,
	ok: Schema.Boolean,
	error: Schema.optional(Schema.String),
	url: Schema.optional(Schema.String),
	title: Schema.optional(Schema.String),
	screenshot: Schema.optional(Schema.String),
	/**
	 * Snapshot → a11y-tree text (CDP path) or JSON array of
	 * `{ ref, role, name, value }` (v1 DOM fallback).
	 */
	snapshot: Schema.optional(Schema.String),
	/** Click/Type/Scroll/… → short human-readable note for the agent. */
	detail: Schema.optional(Schema.String),
	/**
	 * Read → page/element text; Console → console + error log;
	 * Network → request list or one request's detail.
	 */
	text: Schema.optional(Schema.String),
	/** Command-tagged structured response. New commands use this field. */
	payload: Schema.optional(Schema.Unknown),
}) {}

export class BrowserCommandNotFoundError extends Schema.TaggedErrorClass<BrowserCommandNotFoundError>()(
	"BrowserCommandNotFoundError",
	{ id: Schema.String },
) {}

// ---------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------

/**
 * Live stream of pending browser commands. The renderer's BrowserPane
 * subscribes once (independent of which right-pane tab is active) and
 * executes each against the webview. Broadcasting once and filtering on the
 * client mirrors `permission.requests`.
 */
export const BrowserCommandsRpc = Rpc.make("browser.commands", {
	payload: Schema.Struct({}),
	success: BrowserCommandRequest,
	stream: true,
});

/**
 * Renderer posts the outcome of a command back here; the server resolves the
 * Deferred the MCP tool handler is awaiting. Fails if the id is unknown
 * (already resolved, timed out, or from a previous server run).
 */
export const BrowserRespondRpc = Rpc.make("browser.respond", {
	payload: Schema.Struct({ result: BrowserCommandResult }),
	success: Schema.Void,
	error: BrowserCommandNotFoundError,
});

// ---------------------------------------------------------------------------
// Browser credentials (DUMMY / TEST passwords only — see settings UI warning).
// Stored in the OS keychain, namespaced by origin. Write-only from the UI's
// perspective; the password is never returned to the settings UI, only to the
// renderer's Login executor via `browser.fillForOrigin`.
// ---------------------------------------------------------------------------

/** Save (or overwrite) the dummy credential for an origin. */
export const BrowserSetCredentialRpc = Rpc.make("browser.setCredential", {
	payload: Schema.Struct({
		origin: Schema.String,
		username: Schema.String,
		password: Schema.String,
	}),
	success: Schema.Void,
});

/** List saved credentials (origin + username only — never the password). */
export const BrowserListCredentialsRpc = Rpc.make("browser.listCredentials", {
	payload: Schema.Struct({}),
	success: Schema.Array(BrowserCredentialSummary),
});

export const BrowserRemoveCredentialRpc = Rpc.make("browser.removeCredential", {
	payload: Schema.Struct({ origin: Schema.String }),
	success: Schema.Void,
});

/**
 * Renderer-only: fetch the secret for an origin to inject into the page during
 * a Login command. Returns null when nothing is saved. NEVER call this from any
 * agent-facing path — the result is the cleartext dummy password.
 */
export const BrowserFillForOriginRpc = Rpc.make("browser.fillForOrigin", {
	payload: Schema.Struct({ origin: Schema.String }),
	success: Schema.NullOr(BrowserCredentialSecret),
});
