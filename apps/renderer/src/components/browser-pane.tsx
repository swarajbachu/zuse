import { HugeiconsIcon } from "@hugeicons/react";
import { StarIcon } from "@hugeicons-pro/core-solid-rounded";
import {
	type BrowserAnnotationElement,
	type BrowserAnnotationPoint,
	type BrowserAnnotationRect,
	type BrowserAnnotationRegion,
	type BrowserAnnotationStroke,
	type BrowserCommandRequest,
	BrowserCommandResult,
	type BrowserOverlayShape,
	type BrowserTarget,
	type BrowserViewportMode,
	type SessionId,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import {
	Camera,
	ChevronLeft,
	ChevronRight,
	Eraser,
	MousePointer2,
	MousePointerClick,
	PencilLine,
	RefreshCw,
	SendHorizontal,
	Server,
	SquareDashedMousePointer,
	X,
} from "lucide-react";
import {
	type ComponentType,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";

import type {
	BrowserCookieImportStatus,
	BrowserInputAction,
	CdpCommandOutcome,
	LocalServerSummary,
	NetworkQueryResult,
} from "../lib/bridge.ts";
import {
	type BrowserRecordingArtifact,
	BrowserRecordingController,
} from "../lib/browser-recording.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { useAnnotationsStore } from "../store/annotations.ts";
import { useAttachmentsStore } from "../store/attachments.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { AgentCursor, type AgentCursorIntent } from "./agent-cursor.tsx";
import { BrowserSettingsMenu } from "./browser-settings-menu.tsx";
import { BrowserShutter } from "./browser-shutter.tsx";

/**
 * How long the cursor's CSS `transition: transform` lasts. Mirror of GLIDE_MS
 * inside `agent-cursor.tsx` — we wait this long after publishing a move
 * intent before firing the real CDP click so the visible click pulse lands at
 * the destination instead of somewhere along the path.
 */
const CURSOR_GLIDE_MS = 350;

/**
 * Duration of the JS-driven smooth scroll animation injected into the page.
 * Chosen for a clearly human pace — long enough that the user can read
 * what's passing, short enough that a multi-step scroll sequence doesn't
 * drag. The page-side rAF loop uses this exact value; the command waits
 * this long plus a small buffer before letting the next command run.
 */
const SMOOTH_SCROLL_MS = 700;

type BrowserViewportSetting = {
	mode: BrowserViewportMode;
	width: number;
	height: number;
	orientation: "portrait" | "landscape";
	lockAspectRatio: boolean;
};

const VIEWPORT_PRESETS: Record<
	Exclude<BrowserViewportMode, "fill" | "custom">,
	{ width: number; height: number }
> = {
	phone: { width: 390, height: 844 },
	tablet: { width: 768, height: 1024 },
	laptop: { width: 1366, height: 768 },
	desktop: { width: 1440, height: 900 },
};

const DEFAULT_VIEWPORT: BrowserViewportSetting = {
	mode: "fill",
	width: 1440,
	height: 900,
	orientation: "landscape",
	lockAspectRatio: false,
};

type BrowserActionEvent = {
	id: string;
	command: string;
	state: "running" | "succeeded" | "failed" | "interrupted";
	startedAt: string;
	finishedAt?: string;
	error?: string;
};

type AnnotationTool = "select" | "region" | "draw" | "erase";

type BrowserElementPick = BrowserAnnotationElement & { id: string };

const annotationTools: ReadonlyArray<{
	readonly id: AnnotationTool;
	readonly label: string;
	readonly icon: ComponentType<{ className?: string; strokeWidth?: number }>;
}> = [
	{ id: "select", label: "Select", icon: MousePointer2 },
	{ id: "region", label: "Region", icon: SquareDashedMousePointer },
	{ id: "draw", label: "Draw", icon: PencilLine },
	{ id: "erase", label: "Erase", icon: Eraser },
];

const fallbackLocalServers: ReadonlyArray<LocalServerSummary> = [
	{ name: "T3 Code", port: 3773 },
	{ name: "Vite", port: 5173 },
	{ name: "Zuse", port: 5733 },
	{ name: "Next.js", port: 3000 },
];

const newAnnotationId = (prefix: string): string => {
	try {
		return `${prefix}-${crypto.randomUUID()}`;
	} catch {
		return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	}
};

const normalizeRect = (
	start: BrowserAnnotationPoint,
	end: BrowserAnnotationPoint,
): BrowserAnnotationRect => ({
	x: Math.min(start.x, end.x),
	y: Math.min(start.y, end.y),
	width: Math.abs(end.x - start.x),
	height: Math.abs(end.y - start.y),
});

const isUsableRect = (rect: BrowserAnnotationRect): boolean =>
	rect.width >= 4 && rect.height >= 4;

const boundsForPoints = (
	points: ReadonlyArray<BrowserAnnotationPoint>,
): BrowserAnnotationRect => {
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const left = Math.min(...xs);
	const top = Math.min(...ys);
	const right = Math.max(...xs);
	const bottom = Math.max(...ys);
	return { x: left, y: top, width: right - left, height: bottom - top };
};

const unionRects = (
	rects: ReadonlyArray<BrowserAnnotationRect>,
): BrowserAnnotationRect | null => {
	if (rects.length === 0) return null;
	const left = Math.min(...rects.map((rect) => rect.x));
	const top = Math.min(...rects.map((rect) => rect.y));
	const right = Math.max(...rects.map((rect) => rect.x + rect.width));
	const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
	return { x: left, y: top, width: right - left, height: bottom - top };
};

const pointInRect = (
	point: BrowserAnnotationPoint,
	rect: BrowserAnnotationRect,
): boolean =>
	point.x >= rect.x &&
	point.x <= rect.x + rect.width &&
	point.y >= rect.y &&
	point.y <= rect.y + rect.height;

const pathFromPoints = (
	points: ReadonlyArray<BrowserAnnotationPoint>,
): string => {
	if (points.length === 0) return "";
	return points
		.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
		.join(" ");
};

const drawRecordingDecorations = (
	context: CanvasRenderingContext2D,
	width: number,
	height: number,
	bounds: DOMRect,
	shapes: ReadonlyArray<BrowserOverlayShape>,
	cursor: AgentCursorIntent | null,
) => {
	const scaleX = width / Math.max(1, bounds.width);
	const scaleY = height / Math.max(1, bounds.height);
	context.save();
	context.scale(scaleX, scaleY);
	context.lineWidth = 3;
	context.lineCap = "round";
	context.lineJoin = "round";
	for (const shape of shapes) {
		context.strokeStyle = shape.color ?? "rgb(37 99 235)";
		context.fillStyle = shape.color ?? "rgb(37 99 235)";
		if (shape._tag === "Rectangle" || shape._tag === "Highlight") {
			if (shape._tag === "Highlight") {
				context.globalAlpha = 0.22;
				context.fillRect(shape.x, shape.y, shape.width, shape.height);
				context.globalAlpha = 1;
			} else context.strokeRect(shape.x, shape.y, shape.width, shape.height);
		}
		if (shape._tag === "Arrow") {
			context.beginPath();
			context.moveTo(shape.fromX, shape.fromY);
			context.lineTo(shape.toX, shape.toY);
			context.stroke();
		}
		if (shape._tag === "Label") {
			context.font = "600 12px system-ui";
			context.fillText(shape.text, shape.x, shape.y);
		}
		if (shape._tag === "Freehand" && shape.points.length > 1) {
			const first = shape.points[0];
			if (first === undefined) continue;
			context.beginPath();
			context.moveTo(first.x, first.y);
			for (const point of shape.points.slice(1))
				context.lineTo(point.x, point.y);
			context.stroke();
		}
	}
	if (cursor !== null) {
		context.fillStyle = "white";
		context.strokeStyle = "rgb(15 23 42)";
		context.lineWidth = 2;
		context.beginPath();
		context.moveTo(cursor.x, cursor.y);
		context.lineTo(cursor.x + 4, cursor.y + 17);
		context.lineTo(cursor.x + 8, cursor.y + 12);
		context.lineTo(cursor.x + 14, cursor.y + 13);
		context.closePath();
		context.fill();
		context.stroke();
	}
	context.restore();
};

const pngBase64ToFile = (base64: string, name: string): File => {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1)
		bytes[index] = binary.charCodeAt(index);
	return new File([bytes], name, { type: "image/png" });
};

const compositeBrowserImage = async (
	dataUrl: string,
	bounds: DOMRect,
	shapes: ReadonlyArray<BrowserOverlayShape>,
	cursor: AgentCursorIntent | null,
): Promise<string> => {
	if (shapes.length === 0 && cursor === null)
		return dataUrl.replace(/^data:image\/png;base64,/, "");
	const image = await new Promise<HTMLImageElement>((resolve, reject) => {
		const element = new Image();
		element.onload = () => resolve(element);
		element.onerror = () =>
			reject(new Error("Could not composite the browser screenshot."));
		element.src = dataUrl;
	});
	const canvas = document.createElement("canvas");
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;
	const context = canvas.getContext("2d", { alpha: false });
	if (context === null)
		throw new Error("Screenshot compositing is unavailable.");
	context.drawImage(image, 0, 0);
	drawRecordingDecorations(
		context,
		canvas.width,
		canvas.height,
		bounds,
		shapes,
		cursor,
	);
	return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
};

/**
 * In-app Browser tab — toolbar (back/forward/refresh/URL bar) + Electron
 * `<webview>`. The webview runs in its own process with `nodeIntegration:
 * false` by default so arbitrary user-entered URLs can't reach the host.
 *
 * State is held locally: switching away from the Browser tab keeps the
 * component mounted (RightPane uses `hidden` toggling), so URL bar value
 * and the underlying webview's history stay alive across tab switches.
 * Reloading the renderer resets the URL to blank — persistence is out of
 * scope for v1.
 */
export function BrowserPane() {
	const webviewRef = useRef<HTMLElement | null>(null);
	// Ring buffer of console messages + page errors, captured per page load so
	// `browser_console` can report them to the agent. Cleared on navigation.
	const consoleBufferRef = useRef<string[]>([]);
	// Which snapshot minted the refs the agent is currently holding, and (for
	// the CDP a11y path) the ref → backendNodeId map actions resolve through.
	// DOM-mode refs live in the page itself as `data-mz-ref` attributes, so the
	// map stays empty there. Reset on navigation — stale refs must fail with
	// "re-snapshot" rather than land on the wrong node of a new page.
	const refStoreRef = useRef<RefStore>({ mode: "dom", map: new Map() });
	// The embedded webview's webContents id — handed to main once we see
	// `dom-ready` so main can attach Chrome DevTools Protocol and dispatch real
	// input events. `null` until the first dom-ready; null disables CDP paths
	// (Click/Type/Hover/Press fall back to the previous synthetic behaviour so
	// we never silently no-op if the bridge somehow doesn't load).
	const webContentsIdRef = useRef<number | null>(null);
	const recordingRef = useRef(new BrowserRecordingController());
	const actionTimelineRef = useRef<BrowserActionEvent[]>([]);
	const agentOverlaysRef = useRef<BrowserOverlayShape[]>([]);
	const cookieStatusRef = useRef<BrowserCookieImportStatus | null>(null);
	const domainGrantsRef = useRef(new Set<string>());
	const [url, setUrl] = useState<string>("");
	const [inputValue, setInputValue] = useState<string>("");
	const [canGoBack, setCanGoBack] = useState(false);
	const [canGoForward, setCanGoForward] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [recordingState, setRecordingState] = useState<
		"idle" | "starting" | "recording" | "stopping"
	>("idle");
	const [lastRecording, setLastRecording] =
		useState<BrowserRecordingArtifact | null>(null);
	const [agentOverlays, setAgentOverlays] = useState<BrowserOverlayShape[]>([]);
	const [cookieStatus, setCookieStatus] =
		useState<BrowserCookieImportStatus | null>(null);
	const [cookieImportBusy, setCookieImportBusy] = useState(false);
	const [nativeCredentialCapability, setNativeCredentialCapability] = useState<{
		supported: boolean;
		reason?: string;
	} | null>(null);
	const [passwordFieldOrigin, setPasswordFieldOrigin] = useState<string | null>(
		null,
	);
	const [nativeCredentialBusy, setNativeCredentialBusy] = useState(false);
	const [nativeCredentialError, setNativeCredentialError] = useState<
		string | null
	>(null);
	const [domainGrantVersion, setDomainGrantVersion] = useState(0);
	const [domainAccessRequest, setDomainAccessRequest] = useState<{
		domain: string;
		sessionId: string;
		resolve: (allowed: boolean) => void;
	} | null>(null);
	const [viewport, setViewport] = useState<BrowserViewportSetting>(() => {
		try {
			const raw = localStorage.getItem("zuse.browser.viewport.v1");
			return raw === null
				? DEFAULT_VIEWPORT
				: {
						...DEFAULT_VIEWPORT,
						...(JSON.parse(raw) as Partial<BrowserViewportSetting>),
					};
		} catch {
			return DEFAULT_VIEWPORT;
		}
	});
	const viewportRef = useRef(viewport);
	const loadingRef = useRef(isLoading);
	// Bumped each time the agent takes a screenshot — drives the shutter flash.
	const [shutterNonce, setShutterNonce] = useState(0);
	// The current "intent" for the agent cursor overlay. Bumped on every
	// ref-targeted action (click/hover/type/press-with-ref) so the user can see
	// *where* the agent is acting. Stays at the last position once visible —
	// mirrors how a real mouse cursor doesn't disappear between actions.
	const [cursorIntent, setCursorIntent] = useState<AgentCursorIntent | null>(
		null,
	);
	const cursorNonceRef = useRef(0);
	const cursorIntentRef = useRef<AgentCursorIntent | null>(null);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const addBrowserAnnotation = useAnnotationsStore((s) => s.addBrowser);
	const uploadAttachment = useAttachmentsStore((s) => s.uploadOne);
	const [annotating, setAnnotating] = useState(false);
	const [annotationTool, setAnnotationTool] =
		useState<AnnotationTool>("select");
	const [hoverPick, setHoverPick] = useState<BrowserElementPick | null>(null);
	const [pickedElements, setPickedElements] = useState<BrowserElementPick[]>(
		[],
	);
	const [regions, setRegions] = useState<BrowserAnnotationRegion[]>([]);
	const [strokes, setStrokes] = useState<BrowserAnnotationStroke[]>([]);
	const [dragStart, setDragStart] = useState<BrowserAnnotationPoint | null>(
		null,
	);
	const [dragRect, setDragRect] = useState<BrowserAnnotationRect | null>(null);
	const [activeStroke, setActiveStroke] =
		useState<BrowserAnnotationStroke | null>(null);
	const [annotationComment, setAnnotationComment] = useState("");
	const [attachingAnnotation, setAttachingAnnotation] = useState(false);
	const [localServers, setLocalServers] =
		useState<ReadonlyArray<LocalServerSummary>>(fallbackLocalServers);
	const hasLoadedPage = url !== "" && url !== "about:blank";
	const hasAnnotationTargets =
		pickedElements.length > 0 || regions.length > 0 || strokes.length > 0;
	const annotationBounds = unionRects([
		...pickedElements.map((element) => element.rect),
		...regions.map((region) => region.rect),
		...strokes.map((stroke) => stroke.bounds),
	]);
	const displayedCookieStatus: BrowserCookieImportStatus = cookieStatus ?? {
		supported: false,
		availableProfiles: [],
		importedDomainCount: 0,
		importedCookieCount: 0,
		importedDomains: [],
		message: "Browser session import is initializing.",
	};

	useEffect(() => {
		viewportRef.current = viewport;
		localStorage.setItem("zuse.browser.viewport.v1", JSON.stringify(viewport));
	}, [viewport]);
	useEffect(() => {
		loadingRef.current = isLoading;
	}, [isLoading]);

	useEffect(() => {
		let cancelled = false;
		void window.zuse?.browser
			?.getNativeCredentialCapability?.()
			.then((capability) => {
				if (!cancelled) setNativeCredentialCapability(capability);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!hasLoadedPage) {
			setPasswordFieldOrigin(null);
			return;
		}
		let cancelled = false;
		const inspectFocus = async () => {
			const wv = webviewRef.current as WebviewElement | null;
			if (wv === null) return;
			try {
				const focused = (await wv.executeJavaScript(
					`(() => { const active = document.activeElement; return active instanceof HTMLInputElement && active.type === 'password' ? location.origin : null; })()`,
				)) as unknown;
				if (!cancelled)
					setPasswordFieldOrigin(typeof focused === "string" ? focused : null);
			} catch {
				if (!cancelled) setPasswordFieldOrigin(null);
			}
		};
		void inspectFocus();
		const interval = window.setInterval(() => void inspectFocus(), 500);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [hasLoadedPage]);
	useEffect(() => {
		cursorIntentRef.current = cursorIntent;
	}, [cursorIntent]);

	useEffect(
		() => () => {
			if (recordingRef.current.state !== "idle")
				void recordingRef.current.stop().catch(() => {});
		},
		[],
	);

	useEffect(() => {
		const subscribe = window.zuse?.browser?.onScreencastInterrupted;
		if (subscribe === undefined) return;
		return subscribe((webContentsId) => {
			if (
				webContentsIdRef.current !== webContentsId ||
				recordingRef.current.state === "idle"
			)
				return;
			setRecordingState("stopping");
			void recordingRef.current
				.stop()
				.then((artifact) => setLastRecording(artifact))
				.finally(() => setRecordingState("idle"));
		});
	}, []);

	useEffect(() => {
		const element = webviewRef.current;
		if (element === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			const box = entries[0]?.contentRect;
			if (
				box === undefined ||
				(box.width > 0 && box.height > 0) ||
				recordingRef.current.state === "idle"
			)
				return;
			setRecordingState("stopping");
			void recordingRef.current
				.stop()
				.then((artifact) => {
					setLastRecording(artifact);
					setRecordingState("idle");
				})
				.catch(() => setRecordingState("idle"));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		let cancelled = false;
		void window.zuse?.browser
			?.getCookieImportStatus?.()
			.then((status) => {
				if (cancelled) return;
				cookieStatusRef.current = status;
				setCookieStatus(status);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	const runCookieImport = async (profileId?: string) => {
		setCookieImportBusy(true);
		try {
			const status = await window.zuse?.browser?.importCookies?.(profileId);
			if (status === undefined)
				throw new Error("Browser session import is unavailable in this build.");
			cookieStatusRef.current = status;
			setCookieStatus(status);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(message);
		} finally {
			setCookieImportBusy(false);
		}
	};

	const clearImportedCookies = async () => {
		setCookieImportBusy(true);
		try {
			const status = await window.zuse?.browser?.clearImportedCookies?.();
			if (status === undefined)
				throw new Error(
					"Imported-session controls are unavailable in this build.",
				);
			cookieStatusRef.current = status;
			setCookieStatus(status);
			domainGrantsRef.current.clear();
			setDomainGrantVersion(0);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(message);
		} finally {
			setCookieImportBusy(false);
		}
	};

	const clearBrowsingData = async () => {
		setCookieImportBusy(true);
		try {
			const status = await window.zuse?.browser?.clearBrowsingData?.();
			if (status === undefined)
				throw new Error("Clearing browser data is unavailable in this build.");
			cookieStatusRef.current = status;
			setCookieStatus(status);
			domainGrantsRef.current.clear();
			setDomainGrantVersion(0);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(message);
		} finally {
			setCookieImportBusy(false);
		}
	};

	const requestAgentDomainAccess = async (
		req: BrowserCommandRequest,
		wv: WebviewElement | null,
		resolvedCandidate?: string,
	): Promise<boolean> => {
		let status = cookieStatusRef.current;
		if (status === null) {
			const loadStatus = window.zuse?.browser?.getCookieImportStatus;
			if (loadStatus === undefined) return false;
			try {
				status = await loadStatus();
				cookieStatusRef.current = status;
				setCookieStatus(status);
			} catch {
				return false;
			}
		}
		if (status.importedDomains.length === 0) return true;
		let candidate =
			resolvedCandidate ?? (wv === null ? "" : safeCall(() => wv.getURL(), ""));
		if (resolvedCandidate === undefined && req.command._tag === "Navigate") {
			candidate =
				req.command.environmentPort !== undefined &&
				req.command.url.startsWith("/")
					? `${req.command.environmentProtocol ?? "http"}://localhost:${req.command.environmentPort}${req.command.url}`
					: req.command.url;
		}
		let host: string;
		try {
			host = new URL(resolveUrl(candidate) ?? candidate).hostname;
		} catch {
			return true;
		}
		const importedDomain = status.importedDomains.find(
			(domain) => host === domain || host.endsWith(`.${domain}`),
		);
		if (importedDomain === undefined) return true;
		const key = `${req.sessionId}:${importedDomain}`;
		if (domainGrantsRef.current.has(key)) return true;
		return new Promise<boolean>((resolve) =>
			setDomainAccessRequest({
				domain: importedDomain,
				sessionId: String(req.sessionId),
				resolve,
			}),
		);
	};

	useEffect(() => {
		let cancelled = false;
		void window.zuse?.browser?.listLocalServers?.().then((servers) => {
			if (cancelled || servers.length === 0) return;
			setLocalServers(servers);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// Wire navigation lifecycle events onto the underlying webview element.
	// We attach via `addEventListener` because the webview tag isn't a real
	// React component — it's a Chromium-provided custom element.
	useEffect(() => {
		const el = webviewRef.current;
		if (el === null) return;
		const wv = el as WebviewElement;
		const syncNav = () => {
			try {
				setCanGoBack(wv.canGoBack());
				setCanGoForward(wv.canGoForward());
			} catch {
				// webview not ready yet — events fire later
			}
		};
		const registerForCdp = () => {
			const browserBridge = window.zuse?.browser;
			if (browserBridge === undefined) return;
			let id: number;
			try {
				id = wv.getWebContentsId();
			} catch {
				// Pre-Chromium-21 / non-Electron environment — leave id null.
				return;
			}
			if (typeof id !== "number") return;
			// Drop the ref while attach is in flight so an agent action that
			// arrives between dom-ready and a successful attach can't race ahead
			// and hit `Browser input bridge is not ready`. Only set it back after
			// main confirms the debugger attached.
			webContentsIdRef.current = null;
			void browserBridge
				.registerWebview(id)
				.then((ok) => {
					if (ok) webContentsIdRef.current = id;
				})
				.catch(() => {
					// Attach failure is non-fatal — leave id null and CDP-using tools
					// fall back to the synthetic path with a clean cursor animation.
				});
		};
		const onDidNavigate = (e: Event) => {
			const ev = e as Event & { url?: string };
			if (typeof ev.url === "string") {
				setUrl(ev.url);
				setInputValue(ev.url);
			}
			syncNav();
		};
		const onStart = () => {
			setIsLoading(true);
			// Fresh page — drop the previous page's console history and refs.
			consoleBufferRef.current = [];
			refStoreRef.current = { mode: "dom", map: new Map() };
			setAnnotating(false);
			setHoverPick(null);
			setPickedElements([]);
			setRegions([]);
			setStrokes([]);
			setDragStart(null);
			setDragRect(null);
			setActiveStroke(null);
			setAnnotationComment("");
		};
		const onStop = () => {
			setIsLoading(false);
			syncNav();
		};
		const LEVELS = ["log", "info", "warning", "error"] as const;
		const onConsole = (e: Event) => {
			const ev = e as Event & {
				level?: number;
				message?: string;
				line?: number;
				sourceId?: string;
			};
			const level = LEVELS[ev.level ?? 0] ?? "log";
			const where = ev.sourceId ? ` (${ev.sourceId}:${ev.line ?? 0})` : "";
			const line = `[${level}] ${ev.message ?? ""}${where}`;
			const buf = consoleBufferRef.current;
			buf.push(line);
			if (buf.length > 200) buf.splice(0, buf.length - 200);
		};
		const onFailLoad = (e: Event) => {
			const ev = e as Event & {
				errorDescription?: string;
				validatedURL?: string;
			};
			if (ev.errorDescription) {
				consoleBufferRef.current.push(
					`[error] page load failed: ${ev.errorDescription} ${ev.validatedURL ?? ""}`.trim(),
				);
			}
		};
		const onDomReady = () => {
			syncNav();
			registerForCdp();
		};
		el.addEventListener("did-navigate", onDidNavigate);
		el.addEventListener("did-navigate-in-page", onDidNavigate);
		el.addEventListener("did-start-loading", onStart);
		el.addEventListener("did-stop-loading", onStop);
		el.addEventListener("dom-ready", onDomReady);
		el.addEventListener("console-message", onConsole);
		el.addEventListener("did-fail-load", onFailLoad);
		return () => {
			el.removeEventListener("did-navigate", onDidNavigate);
			el.removeEventListener("did-navigate-in-page", onDidNavigate);
			el.removeEventListener("did-start-loading", onStart);
			el.removeEventListener("did-stop-loading", onStop);
			el.removeEventListener("dom-ready", onDomReady);
			el.removeEventListener("console-message", onConsole);
			el.removeEventListener("did-fail-load", onFailLoad);
		};
	}, []);

	// Agent browser executor. Subscribe once to the server's `browser.commands`
	// broadcast and drive the webview for each command, replying on
	// `browser.respond`. Commands run serially (runForEach awaits each) so the
	// agent's navigate→screenshot sequence can't race. The component stays
	// mounted while a project is open, so this subscription lives as long as the
	// pane does.
	useEffect(() => {
		let fiber: Fiber.Fiber<unknown, unknown> | null = null;
		let cancelled = false;
		void (async () => {
			const client = await getRpcClient();
			if (cancelled) return;
			fiber = Effect.runFork(
				Stream.runForEach(client["browser.commands"]({}), (req) =>
					Effect.promise(() => executeBrowserCommand(req)),
				),
			);
		})();

		const executeBrowserCommand = async (
			req: BrowserCommandRequest,
		): Promise<void> => {
			// Always surface the action: open the sidebar and force the Browser
			// panel visible+active. This also un-hides the webview so `capturePage`
			// works (it returns an empty image for a `display:none` element).
			useUiStore.getState().revealPanel("browser");
			const wv = webviewRef.current as WebviewElement | null;
			const accessAllowed = await requestAgentDomainAccess(req, wv);
			if (!accessAllowed) {
				const result = BrowserCommandResult.make({
					id: req.id,
					ok: false,
					error:
						"Access to this imported authenticated domain was denied for the current task.",
				});
				try {
					const client = await getRpcClient();
					await Effect.runPromise(client["browser.respond"]({ result }));
				} catch {}
				return;
			}
			const action: BrowserActionEvent = {
				id: req.id,
				command: req.command._tag,
				state: "running",
				startedAt: new Date().toISOString(),
			};
			actionTimelineRef.current = [
				...actionTimelineRef.current.slice(-98),
				action,
			];
			let result = await runBrowserCommand(req, wv, {
				setUrl,
				setInputValue,
				flashShutter: () => setShutterNonce((n) => n + 1),
				readConsole: () => consoleBufferRef.current.join("\n"),
				moveCursor: (x, y, opts) => {
					cursorNonceRef.current += 1;
					const intent = {
						nonce: cursorNonceRef.current,
						x,
						y,
						click: opts?.click === true,
						pressed: opts?.pressed === true,
					};
					cursorIntentRef.current = intent;
					setCursorIntent(intent);
				},
				getWebContentsId: () => webContentsIdRef.current,
				getRefStore: () => refStoreRef.current,
				setRefStore: (store) => {
					refStoreRef.current = store;
				},
				getLoading: () => loadingRef.current,
				getViewport: () => viewportRef.current,
				setViewport: (next) => {
					viewportRef.current = next;
					setViewport(next);
				},
				getRecordingState: () => recordingRef.current.state,
				startRecording: async () => {
					if (wv === null)
						throw new Error("The browser surface is unavailable.");
					setRecordingState("starting");
					await recordingRef.current.start({
						capturePage: () => wv.capturePage(),
						getBoundingClientRect: () => wv.getBoundingClientRect(),
						subscribeFrames: async (handler) => {
							const bridge = window.zuse?.browser;
							const id = webContentsIdRef.current;
							if (
								id === null ||
								bridge?.startScreencast === undefined ||
								bridge.stopScreencast === undefined ||
								bridge.onScreencastFrame === undefined
							)
								throw new Error("CDP screencast is unavailable.");
							const unsubscribe = bridge.onScreencastFrame((frame) => {
								if (frame.webContentsId === id)
									handler(`data:image/jpeg;base64,${frame.data}`);
							});
							if (!(await bridge.startScreencast(id))) {
								unsubscribe();
								throw new Error("CDP screencast could not start.");
							}
							return async () => {
								unsubscribe();
								await bridge.stopScreencast?.(id);
							};
						},
						drawDecorations: (context, width, height) =>
							drawRecordingDecorations(
								context,
								width,
								height,
								wv.getBoundingClientRect(),
								agentOverlaysRef.current,
								cursorIntentRef.current,
							),
					});
					setRecordingState("recording");
				},
				stopRecording: async () => {
					setRecordingState("stopping");
					const artifact = await recordingRef.current.stop();
					setRecordingState("idle");
					setLastRecording(artifact);
					return artifact;
				},
				getTimeline: () => actionTimelineRef.current,
				getOverlays: () => agentOverlaysRef.current,
				getCursor: () => cursorIntentRef.current,
				setOverlays: (next) => {
					agentOverlaysRef.current = next;
					setAgentOverlays(next);
				},
			});
			if (
				result.ok &&
				req.command._tag === "Navigate" &&
				result.url !== undefined &&
				!(await requestAgentDomainAccess(req, wv, result.url))
			) {
				result = BrowserCommandResult.make({
					id: req.id,
					ok: false,
					error:
						"The navigation redirected to an imported authenticated domain that was not approved for this task.",
				});
			}
			action.state = result.ok ? "succeeded" : "failed";
			action.finishedAt = new Date().toISOString();
			if (!result.ok) action.error = result.error;
			try {
				const client = await getRpcClient();
				await Effect.runPromise(client["browser.respond"]({ result }));
			} catch {
				// A failed respond just means this command times out server-side;
				// the agent gets a clean "browser didn't respond" tool result.
			}
		};

		return () => {
			cancelled = true;
			if (fiber !== null) void Effect.runPromise(Fiber.interrupt(fiber));
		};
	}, []);

	const navigate = (next: string) => {
		const resolved = resolveUrl(next);
		if (resolved === null) return;
		setUrl(resolved);
		setInputValue(resolved);
		const wv = webviewRef.current as WebviewElement | null;
		// Setting `src` programmatically also works, but loadURL is more
		// predictable when the same URL is re-entered (forces a reload). The
		// rejection catch matters: a load superseded by a newer navigation
		// rejects with ERR_ABORTED, which is routine, not an error.
		if (wv !== null) {
			try {
				void wv.loadURL(resolved).catch(() => {});
			} catch {
				wv.src = resolved;
			}
		}
	};

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (inputValue.trim() === "") return;
		navigate(inputValue.trim());
	};

	const go = (dir: "back" | "forward") => {
		const wv = webviewRef.current as WebviewElement | null;
		if (wv === null) return;
		try {
			if (dir === "back" && wv.canGoBack()) wv.goBack();
			if (dir === "forward" && wv.canGoForward()) wv.goForward();
		} catch {
			// ignore
		}
	};

	const reload = () => {
		const wv = webviewRef.current as WebviewElement | null;
		if (wv === null) return;
		try {
			if (isLoading) wv.stop();
			else wv.reload();
		} catch {
			// ignore
		}
	};

	const changeViewportMode = (mode: BrowserViewportMode) => {
		setViewport((current) => {
			if (mode === "fill" || mode === "custom") return { ...current, mode };
			const preset = VIEWPORT_PRESETS[mode];
			const portrait = current.orientation === "portrait";
			return {
				...current,
				mode,
				width: portrait
					? Math.min(preset.width, preset.height)
					: Math.max(preset.width, preset.height),
				height: portrait
					? Math.max(preset.width, preset.height)
					: Math.min(preset.width, preset.height),
			};
		});
	};

	const updateViewportDimension = (
		axis: "width" | "height",
		rawValue: number,
	) => {
		if (!Number.isFinite(rawValue)) return;
		setViewport((current) => {
			const widthLimit = (value: number) =>
				Math.max(240, Math.min(2560, value));
			const heightLimit = (value: number) =>
				Math.max(240, Math.min(1600, value));
			if (axis === "width") {
				const width = widthLimit(Math.round(rawValue));
				return {
					...current,
					mode: "custom",
					width,
					height: current.lockAspectRatio
						? heightLimit(Math.round(width / (current.width / current.height)))
						: current.height,
				};
			}
			const height = heightLimit(Math.round(rawValue));
			return {
				...current,
				mode: "custom",
				height,
				width: current.lockAspectRatio
					? widthLimit(Math.round(height * (current.width / current.height)))
					: current.width,
			};
		});
	};

	const beginViewportResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
		event.preventDefault();
		const startX = event.clientX;
		const startY = event.clientY;
		const initial = viewportRef.current;
		const onMove = (moveEvent: PointerEvent) => {
			const width = initial.width + moveEvent.clientX - startX;
			const height = initial.height + moveEvent.clientY - startY;
			if (initial.lockAspectRatio) {
				updateViewportDimension("width", width);
			} else {
				setViewport((current) => ({
					...current,
					mode: "custom",
					width: Math.max(240, Math.min(2560, Math.round(width))),
					height: Math.max(240, Math.min(1600, Math.round(height))),
				}));
			}
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
	};

	const fillNativeCredential = async (submit = false) => {
		const wv = webviewRef.current as WebviewElement | null;
		const bridge = window.zuse?.browser;
		if (
			wv === null ||
			passwordFieldOrigin === null ||
			bridge?.fillNativeCredential === undefined
		)
			return { ok: false, error: "The password field is no longer available." };
		setNativeCredentialBusy(true);
		setNativeCredentialError(null);
		try {
			const result = await bridge.fillNativeCredential(
				wv.getWebContentsId(),
				passwordFieldOrigin,
				submit,
			);
			if (!result.ok)
				setNativeCredentialError(
					result.error ?? "The password could not be filled.",
				);
			return result;
		} finally {
			setNativeCredentialBusy(false);
		}
	};

	const resetAnnotationDraft = () => {
		setHoverPick(null);
		setPickedElements([]);
		setRegions([]);
		setStrokes([]);
		setDragStart(null);
		setDragRect(null);
		setActiveStroke(null);
		setAnnotationComment("");
	};

	const pointFromEvent = (
		event: ReactPointerEvent<HTMLDivElement>,
	): BrowserAnnotationPoint => {
		const rect = event.currentTarget.getBoundingClientRect();
		return {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
		};
	};

	const pickElementAt = async (
		point: BrowserAnnotationPoint,
	): Promise<BrowserElementPick | null> => {
		const wv = webviewRef.current as WebviewElement | null;
		if (wv === null || url === "") return null;
		const code = `
(() => {
  const x = ${JSON.stringify(point.x)};
  const y = ${JSON.stringify(point.y)};
  const element = document.elementFromPoint(x, y);
  if (!element || element === document.documentElement || element === document.body) return null;
  const selectorFor = (node) => {
    if (node.id) return "#" + CSS.escape(node.id);
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && current !== document.body && parts.length < 4) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
      current = parent;
    }
    return parts.join(" > ");
  };
  const rect = element.getBoundingClientRect();
  const tagName = element.tagName.toLowerCase();
  const text = (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 140);
  const label = element.id ? tagName + "#" + element.id : tagName;
  return {
    tagName,
    selector: selectorFor(element),
    label,
    textPreview: text,
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  };
})()
`;
		try {
			const raw = await wv.executeJavaScript(code);
			if (raw === null || typeof raw !== "object") return null;
			const candidate = raw as BrowserAnnotationElement;
			if (
				typeof candidate.tagName !== "string" ||
				typeof candidate.label !== "string" ||
				typeof candidate.textPreview !== "string" ||
				candidate.rect === undefined ||
				!isUsableRect(candidate.rect)
			) {
				return null;
			}
			return { ...candidate, id: newAnnotationId("element") };
		} catch {
			return null;
		}
	};

	const removeAnnotationTargetAt = (point: BrowserAnnotationPoint): void => {
		setPickedElements((current) =>
			current.filter((element) => !pointInRect(point, element.rect)),
		);
		setRegions((current) =>
			current.filter((region) => !pointInRect(point, region.rect)),
		);
		setStrokes((current) =>
			current.filter((stroke) => !pointInRect(point, stroke.bounds)),
		);
	};

	const handleAnnotationPointerDown = async (
		event: ReactPointerEvent<HTMLDivElement>,
	) => {
		if (!annotating || event.button !== 0) return;
		const point = pointFromEvent(event);
		event.currentTarget.setPointerCapture(event.pointerId);
		event.preventDefault();
		event.stopPropagation();
		if (annotationTool === "select") {
			const picked = await pickElementAt(point);
			if (picked === null) return;
			setPickedElements((current) => {
				const exists = current.some(
					(element) => element.selector === picked.selector,
				);
				return exists ? current : [...current, picked];
			});
			return;
		}
		if (annotationTool === "erase") {
			removeAnnotationTargetAt(point);
			return;
		}
		if (annotationTool === "region") {
			setDragStart(point);
			setDragRect({ ...point, width: 0, height: 0 });
			return;
		}
		if (annotationTool === "draw") {
			setActiveStroke({
				id: newAnnotationId("stroke"),
				points: [point],
				bounds: { ...point, width: 0, height: 0 },
			});
		}
	};

	const handleAnnotationPointerMove = async (
		event: ReactPointerEvent<HTMLDivElement>,
	) => {
		if (!annotating) return;
		const point = pointFromEvent(event);
		if (annotationTool === "select" && dragStart === null) {
			const picked = await pickElementAt(point);
			setHoverPick(picked);
			return;
		}
		if (annotationTool === "region" && dragStart !== null) {
			setDragRect(normalizeRect(dragStart, point));
			return;
		}
		if (annotationTool === "draw" && activeStroke !== null) {
			const points = [...activeStroke.points, point];
			setActiveStroke({
				...activeStroke,
				points,
				bounds: boundsForPoints(points),
			});
		}
	};

	const handleAnnotationPointerUp = (
		event: ReactPointerEvent<HTMLDivElement>,
	) => {
		if (!annotating) return;
		const point = pointFromEvent(event);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		if (annotationTool === "region" && dragStart !== null) {
			const rect = normalizeRect(dragStart, point);
			if (isUsableRect(rect)) {
				setRegions((current) => [
					...current,
					{ id: newAnnotationId("region"), rect },
				]);
			}
			setDragStart(null);
			setDragRect(null);
		}
		if (annotationTool === "draw" && activeStroke !== null) {
			if (
				activeStroke.points.length >= 2 &&
				isUsableRect(activeStroke.bounds)
			) {
				setStrokes((current) => [...current, activeStroke]);
			}
			setActiveStroke(null);
		}
	};

	const attachBrowserAnnotation = async (): Promise<void> => {
		const wv = webviewRef.current as WebviewElement | null;
		if (
			wv === null ||
			selectedSessionId === null ||
			!hasAnnotationTargets ||
			annotationComment.trim().length === 0
		) {
			return;
		}
		setAttachingAnnotation(true);
		try {
			const pagePosition = (await wv
				.executeJavaScript(
					`(() => ({ scrollX, scrollY, deviceScaleFactor: devicePixelRatio || 1 }))()`,
				)
				.catch(() => ({ scrollX: 0, scrollY: 0, deviceScaleFactor: 1 }))) as {
				scrollX: number;
				scrollY: number;
				deviceScaleFactor: number;
			};
			const image = await wv.capturePage();
			const humanShapes: BrowserOverlayShape[] = [
				...pickedElements.map((element) => ({
					_tag: "Rectangle" as const,
					id: element.id,
					...element.rect,
				})),
				...regions.map((region) => ({
					_tag: "Rectangle" as const,
					id: region.id,
					...region.rect,
				})),
				...strokes.map((stroke) => ({
					_tag: "Freehand" as const,
					id: stroke.id,
					points: [...stroke.points],
				})),
			];
			const base64 = await compositeBrowserImage(
				image.toDataURL(),
				wv.getBoundingClientRect(),
				[...agentOverlays, ...humanShapes],
				null,
			);
			const file = pngBase64ToFile(
				base64,
				`browser-annotation-${Date.now()}.png`,
			);
			const screenshotAttachment = await uploadAttachment(
				selectedSessionId as SessionId,
				file,
			);
			addBrowserAnnotation(selectedSessionId, {
				comment: annotationComment.trim(),
				pageUrl: safeCall(() => wv.getURL(), url),
				pageTitle: safeCall(() => wv.getTitle(), "") || null,
				elements: pickedElements.map(({ id: _id, ...element }) => element),
				regions,
				strokes,
				overlays: agentOverlays,
				viewport: {
					mode: viewport.mode,
					width:
						viewport.mode === "fill"
							? Math.round(wv.getBoundingClientRect().width)
							: viewport.width,
					height:
						viewport.mode === "fill"
							? Math.round(wv.getBoundingClientRect().height)
							: viewport.height,
					scrollX: pagePosition.scrollX,
					scrollY: pagePosition.scrollY,
					deviceScaleFactor: pagePosition.deviceScaleFactor,
				},
				screenshotAttachment,
			});
			resetAnnotationDraft();
			setAnnotating(false);
		} catch (error) {
			console.warn("[browser.annotation] attach failed", error);
		} finally {
			setAttachingAnnotation(false);
		}
	};

	return (
		<div className="flex h-full min-h-0 w-full flex-col bg-background">
			<form
				onSubmit={onSubmit}
				className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs"
			>
				<ToolbarButton
					onClick={() => go("back")}
					disabled={!canGoBack}
					ariaLabel="Back"
				>
					<ChevronLeft className="size-3.5" strokeWidth={1.8} />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => go("forward")}
					disabled={!canGoForward}
					ariaLabel="Forward"
				>
					<ChevronRight className="size-3.5" strokeWidth={1.8} />
				</ToolbarButton>
				<ToolbarButton
					onClick={reload}
					disabled={url === ""}
					ariaLabel={isLoading ? "Stop" : "Reload"}
				>
					<RefreshCw
						className={`size-3.5 ${isLoading ? "animate-spin" : ""}`}
						strokeWidth={1.8}
					/>
				</ToolbarButton>
				<ToolbarButton
					onClick={() => {
						/* bookmark placeholder */
					}}
					disabled={true}
					ariaLabel="Bookmark"
				>
					<HugeiconsIcon icon={StarIcon} className="size-3.5" />
				</ToolbarButton>
				<input
					type="text"
					value={inputValue}
					onChange={(e) => setInputValue(e.target.value)}
					placeholder="Search or enter URL"
					spellCheck={false}
					className="flex-1 rounded bg-transparent px-2 py-1 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:bg-muted/40"
				/>
				<select
					value={viewport.mode}
					onChange={(event) =>
						changeViewportMode(event.target.value as BrowserViewportMode)
					}
					aria-label="Browser viewport"
					className="h-8 rounded-md border border-border/70 bg-background px-2 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				>
					<option value="fill">Fill</option>
					<option value="phone">Phone</option>
					<option value="tablet">Tablet</option>
					<option value="laptop">Laptop</option>
					<option value="desktop">Desktop</option>
					<option value="custom">Custom</option>
				</select>
				{viewport.mode === "custom" ? (
					<div className="flex h-8 items-center rounded-md border border-border/70 bg-background">
						<input
							type="number"
							min={240}
							max={2560}
							value={viewport.width}
							onChange={(event) =>
								updateViewportDimension("width", event.target.valueAsNumber)
							}
							aria-label="Viewport width"
							className="h-full w-14 bg-transparent px-1 text-center text-[11px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						/>
						<span className="text-[10px] text-muted-foreground">×</span>
						<input
							type="number"
							min={240}
							max={1600}
							value={viewport.height}
							onChange={(event) =>
								updateViewportDimension("height", event.target.valueAsNumber)
							}
							aria-label="Viewport height"
							className="h-full w-14 bg-transparent px-1 text-center text-[11px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						/>
						<button
							type="button"
							aria-pressed={viewport.lockAspectRatio}
							aria-label="Lock viewport aspect ratio"
							onClick={() =>
								setViewport((current) => ({
									...current,
									lockAspectRatio: !current.lockAspectRatio,
								}))
							}
							className={`h-full px-2 text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${viewport.lockAspectRatio ? "text-primary" : "text-muted-foreground"}`}
						>
							Ratio
						</button>
					</div>
				) : null}
				{viewport.mode !== "fill" ? (
					<button
						type="button"
						onClick={() =>
							setViewport((current) => ({
								...current,
								width: current.height,
								height: current.width,
								orientation:
									current.orientation === "portrait" ? "landscape" : "portrait",
							}))
						}
						className="h-8 rounded-md px-2 text-[11px] tabular-nums text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						aria-label="Rotate browser viewport"
					>
						{viewport.width}×{viewport.height}
					</button>
				) : null}
				{recordingState !== "idle" ? (
					<span
						className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-red-600"
						aria-live="polite"
					>
						<span className="size-2 rounded-full bg-red-500" />
						{recordingState === "recording" ? "Recording" : recordingState}
					</span>
				) : lastRecording !== null ? (
					<span
						className="max-w-24 truncate text-[10px] text-muted-foreground"
						title={lastRecording.id}
					>
						Saved
					</span>
				) : null}
				<ToolbarButton
					onClick={() => {
						if (!hasLoadedPage) return;
						setAnnotating((value) => {
							const next = !value;
							if (!next) resetAnnotationDraft();
							return next;
						});
					}}
					disabled={!hasLoadedPage}
					ariaLabel={annotating ? "Cancel annotation" : "Annotate page"}
				>
					<MousePointerClick
						className={`size-3.5 ${annotating ? "text-primary" : ""}`}
						strokeWidth={1.8}
					/>
				</ToolbarButton>
				<ToolbarButton
					onClick={() => setShutterNonce((n) => n + 1)}
					disabled={!hasLoadedPage}
					ariaLabel="Capture screenshot"
				>
					<Camera className="size-3.5" strokeWidth={1.8} />
				</ToolbarButton>
				<BrowserSettingsMenu
					status={displayedCookieStatus}
					credentialCapability={nativeCredentialCapability}
					busy={cookieImportBusy}
					domainGrantCount={domainGrantVersion}
					onImport={runCookieImport}
					onClearImported={clearImportedCookies}
					onClearBrowsingData={clearBrowsingData}
					onRevokeTaskAccess={() => {
						domainGrantsRef.current.clear();
						setDomainGrantVersion(0);
					}}
				/>
			</form>
			{passwordFieldOrigin !== null ? (
				<section
					className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border/70 bg-card/80 px-3 py-1 text-xs"
					aria-label="Password autofill"
				>
					<div className="min-w-0 flex-1">
						<p className="font-medium text-foreground">
							Password field detected
						</p>
						<p className="truncate text-muted-foreground">
							{nativeCredentialError ??
								nativeCredentialCapability?.reason ??
								`Use the system password picker for ${passwordFieldOrigin}.`}
						</p>
					</div>
					<button
						type="button"
						disabled={
							nativeCredentialBusy ||
							nativeCredentialCapability?.supported !== true
						}
						className="h-8 rounded-md bg-primary px-2.5 font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
						onClick={() => void fillNativeCredential()}
					>
						{nativeCredentialBusy
							? "Opening Passwords…"
							: "Fill from Passwords"}
					</button>
				</section>
			) : null}
			{domainAccessRequest !== null ? (
				<section
					className="shrink-0 border-b border-border/70 bg-card/80 px-3 py-2 text-xs"
					aria-label="Browser session access"
				>
					<div className="flex flex-wrap items-center gap-2">
						<div className="min-w-0 flex-1">
							<p className="font-medium text-foreground">
								Allow this task to use the signed-in session for{" "}
								{domainAccessRequest.domain}?
							</p>
							<p className="mt-0.5 text-muted-foreground">
								The grant stays in memory and applies only to this task and
								domain.
							</p>
						</div>
						<button
							type="button"
							className="h-8 rounded-md border border-border px-2.5 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
							onClick={() => {
								domainAccessRequest.resolve(false);
								setDomainAccessRequest(null);
							}}
						>
							Deny
						</button>
						<button
							type="button"
							className="h-8 rounded-md bg-primary px-2.5 font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
							onClick={() => {
								domainGrantsRef.current.add(
									`${domainAccessRequest.sessionId}:${domainAccessRequest.domain}`,
								);
								setDomainGrantVersion((value) => value + 1);
								domainAccessRequest.resolve(true);
								setDomainAccessRequest(null);
							}}
						>
							Allow for task
						</button>
					</div>
				</section>
			) : null}
			<div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20">
				{!hasLoadedPage ? (
					<BrowserEmptyState servers={localServers} onOpen={navigate} />
				) : null}
				<div
					className="relative shrink-0 overflow-hidden bg-background shadow-sm"
					style={{
						width: viewport.mode === "fill" ? "100%" : `${viewport.width}px`,
						height: viewport.mode === "fill" ? "100%" : `${viewport.height}px`,
					}}
				>
					<webview
						ref={webviewRef as unknown as React.RefObject<HTMLElement>}
						// src is intentionally NOT bound to `url` state. All navigation is
						// imperative (loadURL); if src tracked state, every navigation would
						// fire twice — once from loadURL, once from React re-setting the
						// attribute — and the loads abort each other (ERR_ABORTED -3, agent
						// navigations intermittently reporting about:blank).
						src="about:blank"
						{...({
							allowpopups: "true",
							partition: "persist:zuse-browser",
						} as Record<string, string>)}
						style={{
							display: !hasLoadedPage ? "none" : "flex",
							width: "100%",
							height: "100%",
						}}
					/>
					<BrowserAgentOverlay shapes={agentOverlays} />
					{viewport.mode !== "fill" ? (
						<button
							type="button"
							onPointerDown={beginViewportResize}
							aria-label="Resize browser viewport"
							className="absolute bottom-0 right-0 z-30 size-8 cursor-nwse-resize touch-none bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 after:absolute after:bottom-1 after:right-1 after:size-3 after:border-b-2 after:border-r-2 after:border-muted-foreground/60"
						/>
					) : null}
					{annotating && hasLoadedPage ? (
						<BrowserAnnotationOverlay
							tool={annotationTool}
							setTool={setAnnotationTool}
							hoverPick={hoverPick}
							elements={pickedElements}
							regions={regions}
							strokes={strokes}
							dragRect={dragRect}
							activeStroke={activeStroke}
							bounds={annotationBounds}
							comment={annotationComment}
							setComment={setAnnotationComment}
							canAttach={
								selectedSessionId !== null &&
								hasAnnotationTargets &&
								annotationComment.trim().length > 0
							}
							attaching={attachingAnnotation}
							onAttach={() => void attachBrowserAnnotation()}
							onCancel={() => {
								resetAnnotationDraft();
								setAnnotating(false);
							}}
							onPointerDown={handleAnnotationPointerDown}
							onPointerMove={handleAnnotationPointerMove}
							onPointerUp={handleAnnotationPointerUp}
						/>
					) : null}
					<AgentCursor intent={cursorIntent} visible={hasLoadedPage} />
					<BrowserShutter nonce={shutterNonce} />
				</div>
			</div>
		</div>
	);
}

async function loadUntilEvent(
	wv: WebviewElement,
	url: string,
	eventName: "dom-ready" | "did-stop-loading",
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for ${eventName}.`));
		}, 25_000);
		const done = () => {
			cleanup();
			resolve();
		};
		const cleanup = () => {
			clearTimeout(timeout);
			wv.removeEventListener(eventName, done);
		};
		wv.addEventListener(eventName, done, { once: true });
		try {
			void wv.loadURL(url).catch((error) => {
				cleanup();
				reject(error);
			});
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}

async function buildDiagnosticPayload(
	wv: WebviewElement,
	hooks: {
		readConsole: () => string;
		getWebContentsId: () => number | null;
		getViewport: () => BrowserViewportSetting;
		getLoading: () => boolean;
		getTimeline: () => ReadonlyArray<BrowserActionEvent>;
		getRecordingState: () => string;
	},
	accessibilityTree: string,
	requestedScreenshot?: "viewport" | "full-page",
): Promise<Record<string, unknown>> {
	const visibleTextRaw = await wv
		.executeJavaScript(
			`(() => (document.body?.innerText || document.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 50000))()`,
		)
		.catch(() => "");
	const wcId = hooks.getWebContentsId();
	const network =
		wcId === null
			? []
			: await window.zuse?.browser
					?.getNetwork?.(wcId, {})
					.then((value) =>
						value !== null && "requests" in value
							? value.requests.slice(-200)
							: [],
					)
					.catch(() => []);
	let payload: Record<string, unknown> = {
		url: safeCall(() => wv.getURL(), ""),
		title: safeCall(() => wv.getTitle(), ""),
		loading: hooks.getLoading(),
		viewport: hooks.getViewport(),
		visibleText: typeof visibleTextRaw === "string" ? visibleTextRaw : "",
		accessibilityTree,
		console: hooks.readConsole().split("\n").slice(-100),
		network,
		actions: hooks.getTimeline().slice(-100),
		recording: hooks.getRecordingState(),
		...(requestedScreenshot === undefined
			? {}
			: {
					screenshot: {
						requested: requestedScreenshot,
						availableVia: "browser_screenshot",
					},
				}),
	};
	const structuredBytes = () =>
		new TextEncoder().encode(JSON.stringify(payload)).byteLength;
	for (
		let attempt = 0;
		attempt < 10 && structuredBytes() > 256 * 1024;
		attempt++
	) {
		payload.truncated = true;
		payload.visibleText = String(payload.visibleText).slice(
			0,
			Math.max(1_000, Math.floor(String(payload.visibleText).length / 2)),
		);
		payload.accessibilityTree = String(payload.accessibilityTree).slice(
			0,
			Math.max(2_000, Math.floor(String(payload.accessibilityTree).length / 2)),
		);
		for (const key of ["console", "network", "actions"] as const) {
			const entries = payload[key];
			if (Array.isArray(entries) && entries.length > 5)
				payload[key] = entries.slice(
					-Math.max(5, Math.floor(entries.length / 2)),
				);
		}
	}
	if (structuredBytes() > 256 * 1024) {
		payload = {
			url: payload.url,
			title: payload.title,
			loading: payload.loading,
			viewport: payload.viewport,
			recording: payload.recording,
			truncated: true,
			error: "Diagnostic details exceeded the structured-output limit.",
		};
	}
	return payload;
}

type ResolvedBrowserTarget =
	| { ok: true; cx: number; cy: number; label: string; selector?: string }
	| { ok: false; error: string };

async function resolveBrowserTarget(
	wv: WebviewElement,
	webContentsId: number | null,
	store: RefStore,
	target: BrowserTarget,
): Promise<ResolvedBrowserTarget> {
	if (target._tag === "Point") {
		const bounds = wv.getBoundingClientRect();
		if (
			target.x < 0 ||
			target.y < 0 ||
			target.x > bounds.width ||
			target.y > bounds.height
		) {
			return { ok: false, error: "Target coordinate is outside the viewport." };
		}
		return {
			ok: true,
			cx: target.x,
			cy: target.y,
			label: `point (${target.x}, ${target.y})`,
		};
	}
	if (target._tag === "Ref") {
		if (!isValidRef(target.ref))
			return { ok: false, error: "Invalid snapshot ref." };
		const resolved = await resolveRefTarget(
			wv,
			webContentsId,
			store,
			target.ref,
		);
		return resolved === null
			? { ok: false, error: "Snapshot ref is stale — take a new snapshot." }
			: { ok: true, ...resolved };
	}
	const raw = await wv.executeJavaScript(`(() => {
		const spec = ${JSON.stringify(target)};
		const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0; };
		const roleOf = (el) => el.getAttribute('role') || ({ A:'link', BUTTON:'button', INPUT: el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox', TEXTAREA:'textbox', SELECT:'combobox' }[el.tagName] || '');
		const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
		let matches = [];
		if (spec._tag === 'Css') { try { matches = Array.from(document.querySelectorAll(spec.selector)); } catch { return { error:'Invalid CSS selector.' }; } }
		if (spec._tag === 'Text') matches = Array.from(document.querySelectorAll('body *')).filter((el) => { const value = nameOf(el); return spec.exact ? value === spec.text : value.includes(spec.text); });
		if (spec._tag === 'Role') matches = Array.from(document.querySelectorAll('body *')).filter((el) => { if (roleOf(el).toLowerCase() !== spec.role.toLowerCase()) return false; if (!spec.name) return true; const value = nameOf(el); return spec.exact ? value === spec.name : value.toLowerCase().includes(spec.name.toLowerCase()); });
		matches = matches.filter(visible);
		if (matches.length === 0) return { error:'Target was not found or is not visible.' };
		if (matches.length > 1) return { error:'Target is ambiguous: ' + matches.length + ' visible elements match.' };
		const el = matches[0];
		if (el.matches(':disabled,[aria-disabled="true"]')) return { error:'Target is disabled.' };
		el.scrollIntoView({ block:'center', inline:'center' });
		const r = el.getBoundingClientRect();
		const selector = el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase() + (el.getAttribute('name') ? '[name="' + CSS.escape(el.getAttribute('name')) + '"]' : '');
		return { cx:r.left+r.width/2, cy:r.top+r.height/2, label:nameOf(el).slice(0,80) || el.tagName.toLowerCase(), selector };
	})()`);
	if (raw === null || typeof raw !== "object")
		return { ok: false, error: "The page did not resolve the target." };
	const value = raw as {
		error?: string;
		cx?: number;
		cy?: number;
		label?: string;
		selector?: string;
	};
	if (value.error !== undefined) return { ok: false, error: value.error };
	if (typeof value.cx !== "number" || typeof value.cy !== "number")
		return { ok: false, error: "Target geometry is unavailable." };
	return {
		ok: true,
		cx: value.cx,
		cy: value.cy,
		label: value.label ?? "element",
		...(value.selector !== undefined ? { selector: value.selector } : {}),
	};
}

async function inspectBrowserTarget(
	wv: WebviewElement,
	_target: BrowserTarget,
	resolved: Extract<ResolvedBrowserTarget, { ok: true }>,
): Promise<unknown> {
	return wv.executeJavaScript(`(() => {
		const el = document.elementFromPoint(${JSON.stringify(resolved.cx)}, ${JSON.stringify(resolved.cy)});
		if (!el) return null;
		const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
		return {
			tagName: el.tagName.toLowerCase(), selector: ${JSON.stringify(resolved.selector ?? null)},
			attributes: Object.fromEntries(Array.from(el.attributes).slice(0,100).map((a) => [a.name, a.value.slice(0,1000)])),
			accessible: { role: el.getAttribute('role'), name: el.getAttribute('aria-label') || el.innerText?.trim().slice(0,200) || null, disabled: el.matches(':disabled,[aria-disabled="true"]') },
			box: { x:r.x, y:r.y, width:r.width, height:r.height, pageX:r.x+scrollX, pageY:r.y+scrollY },
			styles: { display:s.display, visibility:s.visibility, opacity:s.opacity, position:s.position, zIndex:s.zIndex, color:s.color, backgroundColor:s.backgroundColor, font:s.font }
		};
	})()`);
}

/**
 * Drive the webview for one agent browser command and build the reply. Pure
 * helper (no React state beyond the passed-in setters) so the executor effect
 * stays small. Never throws — failures come back as `{ ok: false, error }`.
 */
async function runBrowserCommand(
	req: BrowserCommandRequest,
	wv: WebviewElement | null,
	hooks: {
		setUrl: (u: string) => void;
		setInputValue: (u: string) => void;
		flashShutter: () => void;
		readConsole: () => string;
		/**
		 * Glide the agent cursor toward (x, y) in webview-relative CSS pixels.
		 * `click: true` also fires the click pulse once the glide settles.
		 */
		moveCursor: (
			x: number,
			y: number,
			opts?: { click?: boolean; pressed?: boolean },
		) => void;
		/**
		 * The embedded webview's webContents id once main has attached CDP.
		 * `null` before the first `dom-ready`, or if the preload bridge isn't
		 * available (non-Electron build of the renderer).
		 */
		getWebContentsId: () => number | null;
		/** Current snapshot ref store (mode + ref → backendNodeId map). */
		getRefStore: () => RefStore;
		/** Replace the ref store after a fresh snapshot. */
		setRefStore: (store: RefStore) => void;
		getLoading: () => boolean;
		getViewport: () => BrowserViewportSetting;
		setViewport: (setting: BrowserViewportSetting) => void;
		getRecordingState: () => "idle" | "starting" | "recording" | "stopping";
		startRecording: () => Promise<void>;
		stopRecording: () => Promise<BrowserRecordingArtifact>;
		getTimeline: () => ReadonlyArray<BrowserActionEvent>;
		getOverlays: () => ReadonlyArray<BrowserOverlayShape>;
		getCursor: () => AgentCursorIntent | null;
		setOverlays: (shapes: BrowserOverlayShape[]) => void;
	},
): Promise<BrowserCommandResult> {
	const fail = (error: string) =>
		BrowserCommandResult.make({ id: req.id, ok: false, error });
	if (wv === null) {
		return fail("The in-app browser is not available in this window.");
	}
	const command = req.command;
	try {
		switch (command._tag) {
			case "Status": {
				const viewport = hooks.getViewport();
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					payload: {
						available: true,
						url: safeCall(() => wv.getURL(), ""),
						title: safeCall(() => wv.getTitle(), ""),
						loading: hooks.getLoading(),
						visible:
							wv.getBoundingClientRect().width > 0 &&
							wv.getBoundingClientRect().height > 0,
						viewport,
						recording: hooks.getRecordingState(),
						domainAccess: "manual-or-approved",
						capabilities: {
							cdp: hooks.getWebContentsId() !== null,
							accessibility: hooks.getWebContentsId() !== null,
							network: window.zuse?.browser?.getNetwork !== undefined,
							inspection: true,
							evaluation: true,
							recording: window.zuse?.browser?.saveRecording !== undefined,
							overlays: true,
						},
					},
				});
			}
			case "Resize": {
				const current = hooks.getViewport();
				const preset =
					command.mode === "fill" || command.mode === "custom"
						? null
						: VIEWPORT_PRESETS[command.mode];
				let width = Math.round(command.width ?? preset?.width ?? current.width);
				let height = Math.round(
					command.height ?? preset?.height ?? current.height,
				);
				width = Math.min(3840, Math.max(240, width));
				height = Math.min(2160, Math.max(240, height));
				const orientation = command.orientation ?? current.orientation;
				if (
					(orientation === "portrait" && width > height) ||
					(orientation === "landscape" && height > width)
				) {
					[width, height] = [height, width];
				}
				const next: BrowserViewportSetting = {
					mode: command.mode,
					width,
					height,
					orientation,
					lockAspectRatio: command.lockAspectRatio ?? current.lockAspectRatio,
				};
				hooks.setViewport(next);
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					payload: next,
					detail: `Viewport set to ${command.mode}${command.mode === "fill" ? "" : ` (${width}×${height})`}.`,
				});
			}
			case "Navigate": {
				const environmentUrl =
					command.environmentPort !== undefined && command.url.startsWith("/")
						? `${command.environmentProtocol ?? "http"}://localhost:${command.environmentPort}${command.url}`
						: command.url;
				const resolved = resolveUrl(environmentUrl);
				if (resolved === null) return fail(`Invalid URL: ${command.url}`);
				hooks.setUrl(resolved);
				hooks.setInputValue(resolved);
				if (command.readiness === "immediate") {
					void wv.loadURL(resolved).catch(() => {});
					await delay(0);
				} else if (command.readiness === "dom-ready") {
					await loadUntilEvent(wv, resolved, "dom-ready");
				} else {
					await loadAndWait(wv, resolved);
				}
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					url: safeCall(() => wv.getURL(), resolved),
					title: safeCall(() => wv.getTitle(), ""),
				});
			}
			case "Screenshot": {
				const current = safeCall(() => wv.getURL(), "");
				if (current === "" || current === "about:blank") {
					return fail("No page is loaded — navigate to a URL first.");
				}
				// The tab was just made visible; give the compositor a beat to paint
				// before capturing, otherwise the frame can come back blank.
				await delay(180);
				// Full-page goes through CDP (captures beyond the viewport); without
				// the debugger we degrade to the viewport capture below rather than
				// failing — a partial screenshot beats none.
				if (command.fullPage === true) {
					const wcId = hooks.getWebContentsId();
					if (wcId !== null) {
						const shot = await cdpCall(wcId, "Page.captureScreenshot", {
							format: "png",
							captureBeyondViewport: true,
						});
						const data = (shot as { data?: unknown } | null)?.data;
						if (typeof data === "string" && data.length > 0) {
							hooks.flashShutter();
							return BrowserCommandResult.make({
								id: req.id,
								ok: true,
								url: current,
								title: safeCall(() => wv.getTitle(), ""),
								screenshot: data,
							});
						}
					}
				}
				const image = await wv.capturePage();
				if (image.isEmpty()) {
					return fail(
						"Screenshot came back empty — the page may still be loading.",
					);
				}
				const base64 = await compositeBrowserImage(
					image.toDataURL(),
					wv.getBoundingClientRect(),
					hooks.getOverlays(),
					hooks.getCursor(),
				);
				hooks.flashShutter();
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					url: current,
					title: safeCall(() => wv.getTitle(), ""),
					screenshot: base64,
				});
			}
			case "Snapshot": {
				// Prefer the a11y tree over CDP: full-document coverage, roles and
				// states the DOM walk can't see, and ~an order of magnitude cheaper
				// for the model than a screenshot. Any failure (debugger detached,
				// experimental domain missing) falls back to the v1 DOM walk.
				const wcId = hooks.getWebContentsId();
				if (wcId !== null) {
					const built = await buildA11ySnapshot(wcId);
					if (built !== null) {
						hooks.setRefStore({ mode: "cdp", map: built.map });
						const payload = await buildDiagnosticPayload(
							wv,
							hooks,
							built.text,
							command.screenshot,
						);
						return BrowserCommandResult.make({
							id: req.id,
							ok: true,
							url: safeCall(() => wv.getURL(), ""),
							title: safeCall(() => wv.getTitle(), ""),
							snapshot: built.text,
							payload,
						});
					}
				}
				const raw = await wv.executeJavaScript(SNAPSHOT_JS);
				hooks.setRefStore({ mode: "dom", map: new Map() });
				const snapshot =
					typeof raw === "string" ? raw : JSON.stringify(raw ?? []);
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					url: safeCall(() => wv.getURL(), ""),
					title: safeCall(() => wv.getTitle(), ""),
					snapshot,
					payload: await buildDiagnosticPayload(
						wv,
						hooks,
						snapshot,
						command.screenshot,
					),
				});
			}
			case "Click": {
				const wcId = hooks.getWebContentsId();
				const store = hooks.getRefStore();
				const spec =
					command.target ??
					(command.ref !== undefined
						? { _tag: "Ref" as const, ref: command.ref }
						: null);
				if (spec === null)
					return fail("Click requires a browser target or snapshot ref.");
				const target = await resolveBrowserTarget(wv, wcId, store, spec);
				if (!target.ok) return fail(target.error);
				// Without CDP attached (preload bridge missing, attach failed) we
				// can't deliver real input. Fall back to the synthetic click so the
				// agent still makes progress — the cursor animation still runs so
				// the user sees *where* the click landed.
				hooks.moveCursor(target.cx, target.cy, { click: true });
				const delivered =
					wcId !== null &&
					(await dispatchClickViaCdp(wcId, target.cx, target.cy));
				if (!delivered) {
					if (wcId === null) await delay(CURSOR_GLIDE_MS + 20);
					const res =
						spec._tag === "Ref"
							? await callOnRefElement(wv, wcId, store, spec.ref, CLICK_FN, [])
							: await runJsObject(
									wv,
									`(() => { const el = document.elementFromPoint(${target.cx}, ${target.cy}); if (!el) return JSON.stringify({ok:false,error:'Target is no longer visible.'}); el.click(); return JSON.stringify({ok:true}); })()`,
								);
					if (res === null || !res.ok) {
						return fail(
							res?.error ??
								"The click could not be delivered — re-snapshot and retry.",
						);
					}
				}
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					detail: `Clicked ${target.label}.`,
				});
			}
			case "Type": {
				const submit = command.submit === true;
				const wcId = hooks.getWebContentsId();
				const store = hooks.getRefStore();
				const spec =
					command.target ??
					(command.ref !== undefined
						? { _tag: "Ref" as const, ref: command.ref }
						: null);
				if (spec === null)
					return fail("Type requires a browser target or snapshot ref.");
				const target = await resolveBrowserTarget(wv, wcId, store, spec);
				if (!target.ok) return fail(target.error);
				// Glide the cursor to the field with a click pulse — visually frames
				// the field activation. Real focus happens via CDP click (or .focus()
				// when CDP isn't available) so the input shows its native focus ring.
				hooks.moveCursor(target.cx, target.cy, { click: true });
				if (wcId !== null) {
					await dispatchClickViaCdp(wcId, target.cx, target.cy);
				}
				// FILL_FIELD_FN keeps v1's prototype-descriptor value setter: it
				// bypasses React's value tracker — without it, React thinks the
				// controlled value didn't change and the next render reverts the
				// input. Switching to CDP's `Input.insertText` here would regress on
				// common SPA login forms; the real click above already gave the
				// field a true focus event.
				const res =
					spec._tag === "Ref"
						? await callOnRefElement(wv, wcId, store, spec.ref, FILL_FIELD_FN, [
								command.text,
							])
						: await runJsObject(
								wv,
								`(() => { const el = document.elementFromPoint(${target.cx}, ${target.cy}); if (!el) return JSON.stringify({ok:false,error:'Target is no longer visible.'}); return JSON.stringify((${FILL_FIELD_FN}).call(el, ${JSON.stringify(command.text)})); })()`,
							);
				if (submit) {
					if (wcId !== null) {
						await dispatchKeyTap(wcId, "Enter");
					} else {
						if (spec._tag === "Ref")
							await callOnRefElement(wv, wcId, store, spec.ref, ENTER_FN, []);
						else
							await runJsObject(
								wv,
								`(() => JSON.stringify((${ENTER_FN}).call(document.elementFromPoint(${target.cx}, ${target.cy}))))()`,
							);
					}
				}
				return resultFromJs(req.id, res, `Typed into ${target.label}.`);
			}
			case "Wait": {
				// Bounded below the bridge's 30s deadline so a hopeless wait comes
				// back as a clean tool error instead of a bridge timeout.
				const timeoutMs = Math.min(
					Math.max(command.timeoutMs ?? 10000, 100),
					25000,
				);
				if (
					typeof command.selector === "string" &&
					command.selector.length > 0
				) {
					const res = await runJsObject(
						wv,
						`(async () => { const sel = ${JSON.stringify(command.selector)}; const deadline = Date.now() + ${timeoutMs}; while (Date.now() < deadline) { if (document.querySelector(sel)) return JSON.stringify({ ok:true, detail:'Element appeared: ' + sel }); await new Promise(r => setTimeout(r, 150)); } return JSON.stringify({ ok:false, error:'Timed out (${timeoutMs}ms) waiting for ' + sel }); })()`,
					);
					return resultFromJs(req.id, res, "Done waiting.");
				}
				if (typeof command.text === "string" && command.text.length > 0) {
					const res = await runJsObject(
						wv,
						`(async () => { const want = ${JSON.stringify(command.text)}; const deadline = Date.now() + ${timeoutMs}; while (Date.now() < deadline) { if ((document.body?.innerText || '').includes(want)) return JSON.stringify({ ok:true, detail:'Text appeared: "' + want + '"' }); await new Promise(r => setTimeout(r, 150)); } return JSON.stringify({ ok:false, error:'Timed out (${timeoutMs}ms) waiting for text "' + want + '"' }); })()`,
					);
					return resultFromJs(req.id, res, "Done waiting.");
				}
				const ms = Math.min(Math.max(command.ms ?? 500, 0), 15000);
				await delay(ms);
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					detail: `Waited ${ms}ms.`,
				});
			}
			case "WaitFor": {
				const timeoutMs = Math.min(
					Math.max(command.timeoutMs ?? 10_000, 100),
					25_000,
				);
				const started = Date.now();
				let lastError = "conditions were not met";
				while (Date.now() - started < timeoutMs) {
					const failures: string[] = [];
					if (
						command.ms !== undefined &&
						Date.now() - started < Math.max(0, command.ms)
					)
						failures.push("delay");
					if (
						command.urlIncludes !== undefined &&
						!safeCall(() => wv.getURL(), "").includes(command.urlIncludes)
					)
						failures.push("URL");
					if (command.loadingComplete === true && hooks.getLoading())
						failures.push("loading");
					if (command.selector !== undefined || command.text !== undefined) {
						const state = await wv.executeJavaScript(
							`(() => { const selector = ${JSON.stringify(command.selector ?? null)}; const text = ${JSON.stringify(command.text ?? null)}; const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }; return { selector: selector === null || Array.from(document.querySelectorAll(selector)).some(visible), text: text === null || (document.body?.innerText || '').includes(text) }; })()`,
						);
						const value = state as { selector?: boolean; text?: boolean };
						if (value.selector !== true) failures.push("selector");
						if (value.text !== true) failures.push("text");
					}
					if (command.target !== undefined) {
						const target = await resolveBrowserTarget(
							wv,
							hooks.getWebContentsId(),
							hooks.getRefStore(),
							command.target,
						);
						if (!target.ok) failures.push(`target (${target.error})`);
					}
					if (failures.length === 0) {
						return BrowserCommandResult.make({
							id: req.id,
							ok: true,
							payload: {
								elapsedMs: Date.now() - started,
								conditions: "all-passed",
							},
							detail: "All browser wait conditions passed.",
						});
					}
					lastError = failures.join(", ");
					await delay(150);
				}
				return fail(
					`Timed out after ${timeoutMs}ms waiting for: ${lastError}.`,
				);
			}
			case "Scroll": {
				if (typeof command.ref === "string" && command.ref.length > 0) {
					if (!isValidRef(command.ref)) return fail("Invalid element ref.");
					const wcId = hooks.getWebContentsId();
					const store = hooks.getRefStore();
					// Use a JS-driven rAF animation instead of `scrollIntoView({behavior:
					// 'smooth'})` — native smooth scroll varies wildly across pages (some
					// override `scroll-behavior`, some cut the animation short on tiny
					// deltas) and feels choppy. We control duration + easing here so the
					// glide looks the same regardless of the page.
					const res = await callOnRefElement(
						wv,
						wcId,
						store,
						command.ref,
						SMOOTH_SCROLL_REF_FN,
						[],
					);
					await delay(SMOOTH_SCROLL_MS + 60);
					const after = await resolveRefTarget(wv, wcId, store, command.ref);
					if (after !== null) hooks.moveCursor(after.cx, after.cy);
					return resultFromJs(req.id, res, "Scrolled into view.");
				}
				const dir = command.direction ?? "down";
				// Page-step (up/down) glides smoothly. Top/bottom stay instant — on a
				// long page that's a ten-thousand-pixel scroll and animation just
				// wastes the agent's wall-clock without helping the user follow.
				const res = await runJsObject(wv, buildSmoothScrollDirJs(dir));
				if (dir === "up" || dir === "down") {
					await delay(SMOOTH_SCROLL_MS + 60);
				}
				return resultFromJs(req.id, res, `Scrolled ${dir}.`);
			}
			case "Hover": {
				if (!isValidRef(command.ref)) return fail("Invalid element ref.");
				const wcId = hooks.getWebContentsId();
				const store = hooks.getRefStore();
				const target = await resolveRefTarget(wv, wcId, store, command.ref);
				if (target === null) {
					return fail("No element with that ref — re-snapshot first.");
				}
				hooks.moveCursor(target.cx, target.cy);
				if (wcId !== null) {
					// Real `mouseMove` triggers Chromium's hit-testing, which is what
					// makes :hover styles and hover-only menus actually open. Synthetic
					// MouseEvents bubble through the DOM but don't flip the hover state.
					await dispatchInput(wcId, {
						type: "mouseMove",
						x: target.cx,
						y: target.cy,
					});
				} else {
					await callOnRefElement(wv, wcId, store, command.ref, HOVER_FN, []);
				}
				await delay(CURSOR_GLIDE_MS + 20);
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					detail: `Hovered ${target.label}.`,
				});
			}
			case "Select": {
				if (!isValidRef(command.ref)) return fail("Invalid element ref.");
				const res = await callOnRefElement(
					wv,
					hooks.getWebContentsId(),
					hooks.getRefStore(),
					command.ref,
					SELECT_OPTION_FN,
					[command.value],
				);
				return resultFromJs(req.id, res, `Selected ${command.value}.`);
			}
			case "Press": {
				const wcId = hooks.getWebContentsId();
				const store = hooks.getRefStore();
				const hasRef =
					typeof command.ref === "string" && command.ref.length > 0;
				if (hasRef && !isValidRef(command.ref as string)) {
					return fail("Invalid element ref.");
				}
				// Focus the target first (so the keystroke lands on the right
				// element). With CDP we do a real click → cursor moves to it; without
				// CDP we just call `.focus()` via JS.
				if (hasRef) {
					const target = await resolveRefTarget(
						wv,
						wcId,
						store,
						command.ref as string,
					);
					if (target === null) {
						return fail("No element with that ref — re-snapshot first.");
					}
					hooks.moveCursor(target.cx, target.cy, { click: true });
					if (wcId !== null) {
						await dispatchClickViaCdp(wcId, target.cx, target.cy);
					} else {
						await callOnRefElement(
							wv,
							wcId,
							store,
							command.ref as string,
							FOCUS_FN,
							[],
						);
						await delay(CURSOR_GLIDE_MS + 20);
					}
				}
				if (wcId !== null) {
					await dispatchKeyTap(wcId, command.key);
				} else {
					await wv.executeJavaScript(
						`(() => { const el = document.activeElement || document.body; const key = ${JSON.stringify(command.key)}; const o = { key, bubbles:true, cancelable:true }; el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); if (key === 'Enter' && el.form && typeof el.form.requestSubmit === 'function') { try { el.form.requestSubmit(); } catch (e) {} } })()`,
					);
				}
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					detail: `Pressed ${command.key}.`,
				});
			}
			case "Read": {
				if (typeof command.ref === "string" && command.ref.length > 0) {
					if (!isValidRef(command.ref)) return fail("Invalid element ref.");
					const res = await callOnRefElement(
						wv,
						hooks.getWebContentsId(),
						hooks.getRefStore(),
						command.ref,
						READ_TEXT_FN,
						[],
					);
					if (res === null || !res.ok) {
						return fail(res?.error ?? "Could not read that element.");
					}
					return BrowserCommandResult.make({
						id: req.id,
						ok: true,
						url: safeCall(() => wv.getURL(), ""),
						title: safeCall(() => wv.getTitle(), ""),
						text:
							typeof res.text === "string" && res.text.length > 0
								? res.text
								: "(no visible text)",
					});
				}
				const raw = await wv.executeJavaScript(
					`(() => { const el = document.body; if (!el) return ''; return (el.innerText || el.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 8000); })()`,
				);
				const text = typeof raw === "string" ? raw : "";
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					url: safeCall(() => wv.getURL(), ""),
					title: safeCall(() => wv.getTitle(), ""),
					text: text.length > 0 ? text : "(no visible text)",
				});
			}
			case "History": {
				if (command.action === "back") {
					if (!safeCall(() => wv.canGoBack(), false)) {
						return fail("Can't go back — no earlier page in history.");
					}
					wv.goBack();
				} else if (command.action === "forward") {
					if (!safeCall(() => wv.canGoForward(), false)) {
						return fail("Can't go forward — no later page in history.");
					}
					wv.goForward();
				} else {
					wv.reload();
				}
				await waitForStop(wv);
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					url: safeCall(() => wv.getURL(), ""),
					title: safeCall(() => wv.getTitle(), ""),
					detail: `Did ${command.action}.`,
				});
			}
			case "Console": {
				// Three sources merged: the webview's console-message events (v1),
				// uncaught exceptions captured via CDP in main (v2), and — because a
				// blocked page is the most confusing failure mode — a note when a JS
				// dialog is sitting open.
				const parts = [hooks.readConsole()];
				const wcId = hooks.getWebContentsId();
				const bridge = window.zuse?.browser;
				if (wcId !== null && bridge?.getPageErrors !== undefined) {
					const errors = await bridge.getPageErrors(wcId).catch(() => []);
					if (errors.length > 0) parts.push(errors.join("\n"));
				}
				if (wcId !== null && bridge?.getDialogState !== undefined) {
					const dialog = await bridge.getDialogState(wcId).catch(() => null);
					if (dialog !== null) {
						parts.push(
							`[dialog open] ${dialog.type}: "${dialog.message}" — the page is blocked until browser_dialog resolves it.`,
						);
					}
				}
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					text: parts.filter((p) => p.length > 0).join("\n"),
				});
			}
			case "FillForm": {
				if (command.fields.length === 0) {
					return fail("No fields given — pass at least one { ref, value }.");
				}
				const wcId = hooks.getWebContentsId();
				const store = hooks.getRefStore();
				const filled: string[] = [];
				for (const field of command.fields) {
					if (!isValidRef(field.ref)) {
						return fail(`Invalid element ref: ${field.ref}`);
					}
					const target = await resolveRefTarget(wv, wcId, store, field.ref);
					if (target === null) {
						return fail(
							`No element for ref ${field.ref} — re-snapshot first. Already filled: ${
								filled.length > 0 ? filled.join(", ") : "none"
							}.`,
						);
					}
					// Glide (no click pulse) so the user can follow field to field.
					hooks.moveCursor(target.cx, target.cy);
					const res = await callOnRefElement(
						wv,
						wcId,
						store,
						field.ref,
						FILL_FIELD_FN,
						[field.value],
					);
					if (res === null || !res.ok) {
						return fail(
							`${res?.error ?? `Could not fill ${field.ref}.`} Already filled: ${
								filled.length > 0 ? filled.join(", ") : "none"
							}.`,
						);
					}
					filled.push(target.label.length > 0 ? target.label : field.ref);
					await delay(120);
				}
				if (command.submit === true) {
					const lastField = command.fields.at(-1);
					if (lastField === undefined)
						return fail("At least one field is required before submitting.");
					const lastRef = lastField.ref;
					if (wcId !== null) {
						await dispatchKeyTap(wcId, "Enter");
					} else {
						await callOnRefElement(wv, wcId, store, lastRef, ENTER_FN, []);
					}
				}
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					detail: `Filled ${filled.length} field${filled.length === 1 ? "" : "s"} (${filled.join(", ")})${command.submit === true ? " and submitted" : ""}.`,
				});
			}
			case "Network": {
				const wcId = hooks.getWebContentsId();
				const bridge = window.zuse?.browser;
				if (wcId === null || bridge?.getNetwork === undefined) {
					return fail(
						"Network capture is unavailable — the browser's debugger is not attached.",
					);
				}
				const res: NetworkQueryResult = await bridge
					.getNetwork(wcId, {
						...(command.filter !== undefined ? { filter: command.filter } : {}),
						...(command.id !== undefined ? { id: command.id } : {}),
					})
					.catch(() => null);
				if (res === null) {
					return fail(
						command.id !== undefined
							? `No captured request with id ${command.id} — list requests first (they reset on navigation).`
							: "No network activity captured yet.",
					);
				}
				if ("detail" in res) {
					const d = res.detail;
					const lines = [
						`${d.method} ${d.url}`,
						`status: ${d.failed !== undefined ? `FAILED (${d.failed})` : (d.status ?? "(pending)")}  type: ${d.resourceType ?? "?"}  mime: ${d.mimeType ?? "?"}`,
					];
					const headers = Object.entries(d.responseHeaders ?? {}).slice(0, 30);
					if (headers.length > 0) {
						lines.push(
							"response headers:",
							...headers.map(([k, v]) => `  ${k}: ${String(v).slice(0, 200)}`),
						);
					}
					if (typeof d.body === "string" && d.body.length > 0) {
						lines.push(
							d.bodyBase64 === true
								? "body: (binary, base64 — omitted)"
								: `body (truncated to 4000 chars):\n${d.body}`,
						);
					}
					return BrowserCommandResult.make({
						id: req.id,
						ok: true,
						text: lines.join("\n"),
					});
				}
				const rows = res.requests
					.slice(-200)
					.map(
						(r) =>
							`${r.method} ${r.failed !== undefined ? `FAIL(${r.failed})` : (r.status ?? "…")} ${r.resourceType ?? ""} ${r.url.slice(0, 300)}  [id=${r.id}]`,
					);
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					text:
						rows.length > 0
							? rows.join("\n")
							: "(no requests captured since the last page load)",
				});
			}
			case "Dialog": {
				const wcId = hooks.getWebContentsId();
				const bridge = window.zuse?.browser;
				if (
					wcId === null ||
					bridge?.getDialogState === undefined ||
					bridge?.cdpCommand === undefined
				) {
					return fail(
						"Dialog handling is unavailable — the browser's debugger is not attached.",
					);
				}
				const pending = await bridge.getDialogState(wcId).catch(() => null);
				if (pending === null) {
					return fail("No JavaScript dialog is open.");
				}
				const out = await bridge.cdpCommand(
					wcId,
					"Page.handleJavaScriptDialog",
					{
						accept: command.action === "accept",
						...(command.promptText !== undefined
							? { promptText: command.promptText }
							: {}),
					},
				);
				if (!out.ok) {
					return fail(out.error ?? "Could not resolve the dialog.");
				}
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					detail: `${command.action === "accept" ? "Accepted" : "Dismissed"} the ${pending.type}: "${pending.message.slice(0, 200)}".`,
				});
			}
			case "Login": {
				const activeOrigin = safeCall(() => new URL(wv.getURL()).origin, "");
				let requestedOrigin: string;
				try {
					requestedOrigin = new URL(command.origin).origin;
				} catch {
					return fail("Login origin must be an absolute http(s) origin.");
				}
				if (requestedOrigin !== activeOrigin) {
					return fail(
						`Login origin does not match the active page (${activeOrigin || "no page"}).`,
					);
				}
				const nativeBridge = window.zuse?.browser;
				const nativeCapability =
					await nativeBridge?.getNativeCredentialCapability?.();
				const nativeWebContentsId = hooks.getWebContentsId();
				if (
					nativeCapability?.supported === true &&
					nativeWebContentsId !== null &&
					nativeBridge?.fillNativeCredential !== undefined
				) {
					const nativeResult = await nativeBridge.fillNativeCredential(
						nativeWebContentsId,
						activeOrigin,
						true,
					);
					if (nativeResult.ok) {
						return BrowserCommandResult.make({
							id: req.id,
							ok: true,
							detail: `Filled the system credential for ${activeOrigin} and submitted the login form.`,
						});
					}
					return fail(
						nativeResult.error ??
							"The system password picker was cancelled or unavailable.",
					);
				}
				// Pull the dummy secret out-of-band (renderer-only RPC) and inject it
				// straight into the page. The password never returns to the agent —
				// only the ok/detail below, which omit it.
				const client = await getRpcClient();
				const secret = await Effect.runPromise(
					client["browser.fillForOrigin"]({ origin: command.origin }),
				);
				if (secret === null) {
					return fail(
						`No system or saved test credential is available for ${command.origin}. Sign in manually or add a test login in Settings → Browser.`,
					);
				}
				const res = await runJsObject(
					wv,
					`(() => { const U = ${JSON.stringify(secret.username)}; const P = ${JSON.stringify(secret.password)}; const pw = document.querySelector('input[type="password"]'); if (!pw) return JSON.stringify({ ok:false, error:'No password field on this page — navigate to the login form first.' }); let user = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]'); if (!user) { user = Array.from(document.querySelectorAll('input')).find((i) => /^(text|email|)$/.test(i.type)) || null; } const setVal = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value'); if (d && d.set) d.set.call(el, v); else el.value = v; el.dispatchEvent(new Event('input', { bubbles:true })); el.dispatchEvent(new Event('change', { bubbles:true })); }; if (user) setVal(user, U); setVal(pw, P); const form = pw.form; if (form && typeof form.requestSubmit === 'function') { try { form.requestSubmit(); return JSON.stringify({ ok:true, detail:'Filled and submitted the login form.' }); } catch (e) {} } pw.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', keyCode:13, which:13, bubbles:true })); return JSON.stringify({ ok:true, detail:'Filled the saved credentials and pressed Enter.' }); })()`,
				);
				return resultFromJs(req.id, res, "Submitted the saved login.");
			}
			case "Inspect": {
				const target = await resolveBrowserTarget(
					wv,
					hooks.getWebContentsId(),
					hooks.getRefStore(),
					command.target,
				);
				if (!target.ok) return fail(target.error);
				const inspection = await inspectBrowserTarget(
					wv,
					command.target,
					target,
				);
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					payload: inspection,
					detail: `Inspected ${target.label}.`,
				});
			}
			case "Evaluate": {
				if (command.expression.length > 64 * 1024)
					return fail("JavaScript expression exceeds 64 KiB.");
				const value = await wv.executeJavaScript(
					`(async () => { const value = ${command.awaitPromise === true ? "await " : ""}(${command.expression}); return value === undefined ? null : value; })()`,
				);
				let encoded: string;
				try {
					encoded = JSON.stringify(value);
				} catch {
					return fail("Evaluation result is not JSON serializable.");
				}
				if (encoded.length > 64 * 1024)
					return fail("Evaluation result exceeds 64 KiB.");
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					payload: { value },
					detail: "Evaluation completed.",
				});
			}
			case "RecordingStart": {
				await hooks.startRecording();
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					payload: { state: "recording", startedAt: new Date().toISOString() },
					detail: "Browser recording started.",
				});
			}
			case "RecordingStop": {
				const artifact = await hooks.stopRecording();
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					payload: artifact,
					detail: "Browser recording saved.",
				});
			}
			case "Overlay": {
				const previous = [...hooks.getOverlays()];
				let next = previous;
				if (command.action === "clear") next = [];
				if (command.action === "remove" && command.id !== undefined)
					next = previous.filter((shape) => shape.id !== command.id);
				if (command.action === "add") {
					if (command.shape === undefined)
						return fail("Overlay add requires a shape.");
					const addedShape = command.shape;
					next = [
						...previous.filter((shape) => shape.id !== addedShape.id),
						addedShape,
					];
				}
				if (command.action === "undo") next = previous.slice(0, -1);
				if (command.action === "redo")
					return fail("Nothing to redo in this browser session.");
				hooks.setOverlays(next);
				return BrowserCommandResult.make({
					id: req.id,
					ok: true,
					payload: { count: next.length, shapes: next },
					detail: `Browser overlay now has ${next.length} mark(s).`,
				});
			}
		}
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}

// Snapshot refs are minted as `e<number>` — validate before string-injecting
// into a querySelector so a crafted ref can't break out of the selector.
const isValidRef = (ref: string): boolean => /^e\d+$/.test(ref);

/**
 * Which snapshot mode minted the refs the agent currently holds. `cdp` refs
 * resolve through backendNodeIds (a11y tree); `dom` refs live in the page as
 * `data-mz-ref` attributes (v1 fallback). A store from one page never
 * survives navigation — see the `did-start-loading` reset.
 */
type RefStore = {
	mode: "dom" | "cdp";
	map: Map<string, { backendNodeId: number; label: string }>;
};

/**
 * One allowlisted CDP call through the preload bridge. Returns the raw CDP
 * result object, or null on any failure (bridge absent, method rejected,
 * debugger detached) — callers treat null as "fall back or fail soft".
 */
async function cdpCall(
	webContentsId: number,
	method: string,
	params?: unknown,
): Promise<unknown | null> {
	const fn = window.zuse?.browser?.cdpCommand;
	if (fn === undefined) return null;
	try {
		const out: CdpCommandOutcome = await fn(webContentsId, method, params);
		return out.ok ? (out.result ?? {}) : null;
	} catch {
		return null;
	}
}

/**
 * Resolve a snapshot ref to webview-relative CSS-pixel center coords + label,
 * scrolling the element into view first (so a click can't miss because the
 * page moved between snapshot and action). CDP mode goes backendNodeId →
 * `DOM.scrollIntoViewIfNeeded` → `DOM.getContentQuads`; DOM mode keeps the
 * v1 querySelector path. Null → ref is stale, tell the agent to re-snapshot.
 */
async function resolveRefTarget(
	wv: WebviewElement,
	webContentsId: number | null,
	store: RefStore,
	ref: string,
): Promise<{ cx: number; cy: number; label: string } | null> {
	if (store.mode === "cdp") {
		const entry = store.map.get(ref);
		if (entry === undefined || webContentsId === null) return null;
		await cdpCall(webContentsId, "DOM.scrollIntoViewIfNeeded", {
			backendNodeId: entry.backendNodeId,
		});
		const res = await cdpCall(webContentsId, "DOM.getContentQuads", {
			backendNodeId: entry.backendNodeId,
		});
		const quads = (res as { quads?: unknown } | null)?.quads;
		if (!Array.isArray(quads) || quads.length === 0) return null;
		const q = quads[0] as number[];
		if (!Array.isArray(q) || q.length < 8) return null;
		const [
			x0 = Number.NaN,
			y0 = Number.NaN,
			x1 = Number.NaN,
			y1 = Number.NaN,
			x2 = Number.NaN,
			y2 = Number.NaN,
			x3 = Number.NaN,
			y3 = Number.NaN,
		] = q;
		const cx = (x0 + x1 + x2 + x3) / 4;
		const cy = (y0 + y1 + y2 + y3) / 4;
		if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
		return { cx, cy, label: entry.label };
	}
	return resolveRefRect(wv, ref);
}

/**
 * Run one of the `*_FN` page functions against a ref's element, whichever
 * mode minted the ref. CDP mode: `DOM.resolveNode` → `Runtime.callFunctionOn`
 * with the element as `this` (works for a11y refs that have no DOM marker).
 * DOM mode: the same function source is applied to the `data-mz-ref` element
 * via `executeJavaScript`. Both return the function's `{ ok, ... }` object.
 */
async function callOnRefElement(
	wv: WebviewElement,
	webContentsId: number | null,
	store: RefStore,
	ref: string,
	fnDecl: string,
	args: ReadonlyArray<string | number | boolean>,
): Promise<{
	ok: boolean;
	error?: string;
	detail?: string;
	text?: string;
} | null> {
	if (store.mode === "cdp") {
		const entry = store.map.get(ref);
		if (entry === undefined || webContentsId === null) {
			return {
				ok: false,
				error: "No element with that ref — re-snapshot the page first.",
			};
		}
		const resolved = await cdpCall(webContentsId, "DOM.resolveNode", {
			backendNodeId: entry.backendNodeId,
		});
		const objectId = (resolved as { object?: { objectId?: unknown } } | null)
			?.object?.objectId;
		if (typeof objectId !== "string") {
			return {
				ok: false,
				error: "That element is gone — re-snapshot the page first.",
			};
		}
		const call = await cdpCall(webContentsId, "Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: fnDecl,
			returnByValue: true,
			arguments: args.map((value) => ({ value })),
		});
		const value = (call as { result?: { value?: unknown } } | null)?.result
			?.value;
		return value !== null && typeof value === "object"
			? (value as {
					ok: boolean;
					error?: string;
					detail?: string;
					text?: string;
				})
			: { ok: false, error: "The page did not respond to the action." };
	}
	return runJsObject(
		wv,
		`(() => { const el = document.querySelector('[data-mz-ref=${JSON.stringify(ref)}]'); if (!el) return JSON.stringify({ ok:false, error:'No element with that ref — re-snapshot the page first.' }); return JSON.stringify((${fnDecl}).apply(el, ${JSON.stringify(args)})); })()`,
	);
}

// ---------------------------------------------------------------------------
// Page functions shared by both ref modes. Each runs with the target element
// as `this` and returns a plain `{ ok, error?, detail?, text? }` object —
// callOnRefElement handles the mode-specific delivery and serialization.
// ---------------------------------------------------------------------------

const CLICK_FN = `function () { this.click(); return { ok: true }; }`;

const FOCUS_FN = `function () { if (typeof this.focus === 'function') this.focus(); return { ok: true }; }`;

const HOVER_FN = `function () { const el = this; const r = el.getBoundingClientRect(); const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; for (const t of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(t, o)); return { ok: true }; }`;

const READ_TEXT_FN = `function () { const el = this; return { ok: true, text: (el.innerText || el.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 8000) }; }`;

/**
 * Fill an input/textarea/select/contenteditable. Keeps v1's prototype-
 * descriptor value setter (bypasses React's value tracker so controlled
 * inputs don't revert on the next render) and folds in <select> matching so
 * FillForm can hit mixed forms with one function.
 */
const FILL_FIELD_FN = `function (v) { const el = this; el.focus(); const tag = el.tagName; if (tag === 'SELECT') { const opt = Array.from(el.options).find((o) => o.value === v || (o.textContent || '').trim() === v); if (!opt) return { ok: false, error: 'No option matching "' + v + '".' }; el.value = opt.value; } else if (tag === 'INPUT' || tag === 'TEXTAREA') { const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value'); if (d && d.set) d.set.call(el, v); else el.value = v; } else { el.textContent = v; } el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, detail: 'Filled ' + ((el.getAttribute('name') || el.getAttribute('aria-label') || el.tagName) || '') }; }`;

const SELECT_OPTION_FN = `function (v) { const el = this; if (el.tagName !== 'SELECT') return { ok: false, error: 'That ref is not a <select> dropdown.' }; const opt = Array.from(el.options).find((o) => o.value === v || (o.textContent || '').trim() === v); if (!opt) return { ok: false, error: 'No option matching "' + v + '".' }; el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, detail: 'Selected ' + (opt.textContent || opt.value) }; }`;

const ENTER_FN = `function () { const el = this; const o = { key: 'Enter', keyCode: 13, which: 13, bubbles: true }; el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); const f = el.form; if (f && typeof f.requestSubmit === 'function') { try { f.requestSubmit(); } catch (e) {} } return { ok: true }; }`;

/**
 * Resolve a snapshot ref to webview-relative pixel coords + a short label.
 * Scrolls the element into view first so the agent's click can't miss because
 * it scrolled out between snapshot and action. The label drives the human-
 * readable detail strings ("Clicked Sign in"); we read it page-side because
 * it's cheaper than copying the snapshot back across the bridge.
 *
 * Returns null when the ref no longer matches anything (snapshot is stale).
 */
async function resolveRefRect(
	wv: WebviewElement,
	ref: string,
): Promise<{ cx: number; cy: number; label: string } | null> {
	const raw = await wv.executeJavaScript(
		`(() => { const el = document.querySelector('[data-mz-ref=${JSON.stringify(ref)}]'); if (!el) return null; el.scrollIntoView({ block:'center', inline:'center' }); const r = el.getBoundingClientRect(); const label = ((el.innerText||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.tagName)||'').replace(/\\s+/g,' ').trim().slice(0,60); return JSON.stringify({ cx: r.left + r.width/2, cy: r.top + r.height/2, label }); })()`,
	);
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw) as {
			cx: number;
			cy: number;
			label: string;
		};
		if (
			typeof parsed.cx !== "number" ||
			typeof parsed.cy !== "number" ||
			!Number.isFinite(parsed.cx) ||
			!Number.isFinite(parsed.cy)
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Send one CDP input action through the preload bridge. Returns false if
 * the bridge isn't present (renderer running outside Electron) or main
 * reports the dispatch failed (debugger not attached, webContents destroyed).
 */
async function dispatchInput(
	webContentsId: number,
	action: BrowserInputAction,
): Promise<boolean> {
	const bridge = window.zuse?.browser;
	if (bridge === undefined) return false;
	try {
		return await bridge.dispatchInput(webContentsId, action);
	} catch {
		return false;
	}
}

/**
 * Move-then-press-then-release at (x, y). Waits the cursor's glide duration
 * between the move and the press so the visible click pulse lands at the
 * destination, not somewhere mid-glide. The two-event press/release pair is
 * what makes pages see a "real" click (vs `el.click()`, which fires only a
 * synthetic `click` event and skips mousedown/mouseup).
 */
async function dispatchClickViaCdp(
	webContentsId: number,
	x: number,
	y: number,
): Promise<boolean> {
	const moved = await dispatchInput(webContentsId, {
		type: "mouseMove",
		x,
		y,
	});
	if (!moved) return false;
	await delay(CURSOR_GLIDE_MS);
	await dispatchInput(webContentsId, {
		type: "mousePressed",
		x,
		y,
		button: "left",
		clickCount: 1,
	});
	// A few ms between press/release looks more natural to long-press
	// detectors and matches real-mouse cadence. Most pages don't care.
	await delay(15);
	await dispatchInput(webContentsId, {
		type: "mouseReleased",
		x,
		y,
		button: "left",
		clickCount: 1,
	});
	return true;
}

/**
 * Tap a named key (`Enter`, `Tab`, `Escape`, `ArrowDown`, …) via CDP on the
 * focused element. `text` is set for printable single chars so the page sees
 * a real `input` event in `<textarea>`/contenteditable; non-printable keys
 * (Enter, arrows) leave `text` blank, mirroring Chromium's own handling.
 */
async function dispatchKeyTap(
	webContentsId: number,
	key: string,
): Promise<void> {
	const isPrintable = key.length === 1;
	const payload: BrowserInputAction = {
		type: "keyDown",
		key,
		...(isPrintable ? { text: key } : {}),
	};
	await dispatchInput(webContentsId, payload);
	await dispatchInput(webContentsId, {
		type: "keyUp",
		key,
	});
}

/**
 * Center the element in the viewport with the same rAF glide as directional
 * scroll. Self-contained (returns `{ ok }` on every path — the early-exit
 * for tiny deltas must not fall through to `undefined`).
 */
const SMOOTH_SCROLL_REF_FN = `function () { const el = this; const r = el.getBoundingClientRect(); const targetY = Math.max(0, window.scrollY + r.top - (window.innerHeight - r.height) / 2); const start = window.scrollY; const dist = targetY - start; if (Math.abs(dist) < 2) { window.scrollTo(0, targetY); return { ok: true, detail: 'Already in view.' }; } const dur = ${SMOOTH_SCROLL_MS}; const t0 = performance.now(); const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2); function step(now) { const p = Math.min(1, (now - t0) / dur); window.scrollTo(0, start + dist * ease(p)); if (p < 1) requestAnimationFrame(step); } requestAnimationFrame(step); return { ok: true, detail: 'Scrolled element into view.' }; }`;

/** Run page JS that returns a JSON string and parse it; null on any failure. */
async function runJsObject(
	wv: WebviewElement,
	code: string,
): Promise<{
	ok: boolean;
	error?: string;
	detail?: string;
	text?: string;
} | null> {
	const raw = await wv.executeJavaScript(code);
	if (typeof raw !== "string") return null;
	try {
		return JSON.parse(raw) as {
			ok: boolean;
			error?: string;
			detail?: string;
			text?: string;
		};
	} catch {
		return null;
	}
}

const resultFromJs = (
	id: string,
	res: { ok: boolean; error?: string; detail?: string } | null,
	fallbackDetail: string,
): BrowserCommandResult =>
	res === null
		? BrowserCommandResult.make({
				id,
				ok: false,
				error: "The page did not respond to the action.",
			})
		: BrowserCommandResult.make({
				id,
				ok: res.ok,
				...(res.ok
					? { detail: res.detail ?? fallbackDetail }
					: { error: res.error ?? "Action failed." }),
			});

// ---------------------------------------------------------------------------
// Accessibility-tree snapshot (v2). Fetches the full AX tree over CDP and
// renders the Playwright-style compact text the whole industry converged on:
// one line per meaningful node, interactive elements carrying `ref=eN`.
// ---------------------------------------------------------------------------

type AxValue = { value?: unknown };
type AxNode = {
	nodeId: string;
	ignored?: boolean;
	role?: AxValue;
	name?: AxValue;
	value?: AxValue;
	properties?: Array<{ name?: string; value?: AxValue }>;
	childIds?: string[];
	backendDOMNodeId?: number;
	parentId?: string;
};

/** Roles the agent can act on — these get a `ref` (needs a backing DOM node). */
const INTERACTIVE_ROLES = new Set([
	"link",
	"button",
	"textbox",
	"searchbox",
	"textfield",
	"textfieldwithcombobox",
	"checkbox",
	"radio",
	"combobox",
	"listbox",
	"option",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"tab",
	"switch",
	"slider",
	"spinbutton",
	"togglebutton",
	"popupbutton",
	"menubutton",
	"disclosuretriangle",
]);

/** Structural roles worth a line for context even without interactivity. */
const STRUCTURAL_ROLES = new Set([
	"heading",
	"banner",
	"navigation",
	"main",
	"contentinfo",
	"form",
	"search",
	"region",
	"complementary",
	"article",
	"list",
	"listitem",
	"descriptionlist",
	"table",
	"row",
	"cell",
	"gridcell",
	"columnheader",
	"rowheader",
	"image",
	"img",
	"figure",
	"dialog",
	"alertdialog",
	"alert",
	"status",
	"tabpanel",
	"tablist",
	"menu",
	"menubar",
	"toolbar",
	"tree",
	"treeitem",
]);

const SNAPSHOT_MAX_LINES = 800;
const SNAPSHOT_MAX_CHARS = 20000;

/**
 * Fetch `Accessibility.getFullAXTree` and render the pruned text tree +
 * ref map. Null on any failure (domain unavailable, empty tree) so the
 * caller can fall back to the v1 DOM snapshot. The `DOM.getDocument` call
 * warms the DOM agent so later backendNodeId lookups resolve reliably.
 */
async function buildA11ySnapshot(webContentsId: number): Promise<{
	text: string;
	map: Map<string, { backendNodeId: number; label: string }>;
} | null> {
	await cdpCall(webContentsId, "DOM.getDocument", { depth: 0 });
	const res = await cdpCall(webContentsId, "Accessibility.getFullAXTree", {});
	const nodes = (res as { nodes?: unknown } | null)?.nodes;
	if (!Array.isArray(nodes) || nodes.length === 0) return null;
	const byId = new Map<string, AxNode>();
	for (const raw of nodes as AxNode[]) {
		if (typeof raw?.nodeId === "string") byId.set(raw.nodeId, raw);
	}
	const root =
		(nodes as AxNode[]).find((n) => n.parentId === undefined) ??
		(nodes as AxNode[])[0];
	if (root === undefined) return null;

	const map = new Map<string, { backendNodeId: number; label: string }>();
	const lines: string[] = [];
	let chars = 0;
	let skipped = 0;
	let refCounter = 0;

	const prop = (node: AxNode, name: string): unknown =>
		node.properties?.find((p) => p.name === name)?.value?.value;

	const emitLine = (line: string): boolean => {
		if (lines.length >= SNAPSHOT_MAX_LINES || chars >= SNAPSHOT_MAX_CHARS) {
			skipped += 1;
			return false;
		}
		lines.push(line);
		chars += line.length + 1;
		return true;
	};

	const walk = (node: AxNode, depth: number, parentName: string): void => {
		let nextDepth = depth;
		let nextParentName = parentName;
		if (node.ignored !== true) {
			const role = String(node.role?.value ?? "");
			const lrole = role.toLowerCase();
			const name = String(node.name?.value ?? "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 80);
			const interactive =
				INTERACTIVE_ROLES.has(lrole) &&
				typeof node.backendDOMNodeId === "number";
			const isText = lrole === "statictext" || lrole === "text";
			const structural = STRUCTURAL_ROLES.has(lrole);
			// Emit: everything actionable; structure with a name (or a heading —
			// its text is its name); text that isn't just repeating its parent's
			// label. Nameless generic containers are flattened away.
			const emit = interactive
				? true
				: isText
					? name.length > 0 && name !== parentName
					: structural && (name.length > 0 || lrole === "heading");
			if (emit) {
				const parts: string[] = [`${"  ".repeat(Math.min(depth, 10))}- `];
				if (isText) {
					parts.push(`text "${name}"`);
				} else {
					parts.push(lrole);
					if (name.length > 0) parts.push(` "${name}"`);
				}
				if (interactive && typeof node.backendDOMNodeId === "number") {
					refCounter += 1;
					const ref = `e${refCounter}`;
					map.set(ref, {
						backendNodeId: node.backendDOMNodeId,
						label: name.length > 0 ? name : lrole,
					});
					parts.push(` [ref=${ref}]`);
				}
				const value = String(node.value?.value ?? "")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 60);
				if (value.length > 0 && !isText) parts.push(` [value="${value}"]`);
				const level = prop(node, "level");
				if (lrole === "heading" && typeof level === "number") {
					parts.push(` [level=${level}]`);
				}
				for (const flag of [
					"disabled",
					"checked",
					"expanded",
					"selected",
					"required",
				]) {
					const v = prop(node, flag);
					if (v === true || v === "true" || v === "mixed")
						parts.push(` [${flag}]`);
				}
				if (emitLine(parts.join(""))) {
					nextDepth = depth + 1;
					nextParentName = name.length > 0 ? name : parentName;
				}
			}
		}
		for (const childId of node.childIds ?? []) {
			const child = byId.get(childId);
			if (child !== undefined) walk(child, nextDepth, nextParentName);
		}
	};

	walk(root, 0, "");
	if (lines.length === 0) return null;
	if (skipped > 0) {
		lines.push(
			`… truncated — ${skipped} more nodes. Use browser_read for full text, or act on the refs above.`,
		);
	}
	return { text: lines.join("\n"), map };
}

/**
 * Page-side DOM snapshot (v1 fallback — used when CDP isn't attached).
 * Clears stale refs, then tags every visible interactive element with a
 * fresh `data-mz-ref` and returns a compact JSON array
 * `[{ ref, role, name, value, tag }]` for the agent to target.
 */
const SNAPSHOT_JS = `(() => {
  document.querySelectorAll('[data-mz-ref]').forEach((e) => e.removeAttribute('data-mz-ref'));
  const sel = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="tab"], [role="menuitem"], [onclick], [contenteditable="true"]';
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0.05 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight + 400;
    if (!visible) continue;
    if (el.disabled) continue;
    const ref = 'e' + (++i);
    el.setAttribute('data-mz-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag);
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.innerText || '').trim() || el.getAttribute('name') || el.getAttribute('title') || el.getAttribute('value') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const value = (el.value != null ? String(el.value) : '').slice(0, 80);
    out.push({ ref, role, name, value, tag });
    if (out.length >= 200) break;
  }
  return JSON.stringify(out);
})()`;

/**
 * Page-side rAF smooth-scroll loop. Cubic ease-in-out over a fixed duration
 * so the animation looks identical on every site — `window.scrollTo({behavior:
 * 'smooth'})` honors per-site `scroll-behavior` overrides and finishes faster
 * than the user can read what passed, which is why this exists.
 */
const SMOOTH_SCROLL_BODY = `
  const start = window.scrollY;
  const dist = targetY - start;
  if (Math.abs(dist) < 2) { window.scrollTo(0, targetY); return; }
  const dur = ${SMOOTH_SCROLL_MS};
  const t0 = performance.now();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function step(now) {
    const p = Math.min(1, (now - t0) / dur);
    window.scrollTo(0, start + dist * ease(p));
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
`;

const buildSmoothScrollDirJs = (
	dir: "up" | "down" | "top" | "bottom",
): string => {
	if (dir === "top") {
		return `(() => { window.scrollTo({ top:0, behavior:'instant' }); return JSON.stringify({ ok:true, detail:'Scrolled top.' }); })()`;
	}
	if (dir === "bottom") {
		return `(() => { window.scrollTo({ top:document.body.scrollHeight, behavior:'instant' }); return JSON.stringify({ ok:true, detail:'Scrolled bottom.' }); })()`;
	}
	const sign = dir === "up" ? -1 : 1;
	return `(() => { const h = window.innerHeight; const targetY = Math.max(0, Math.min(document.body.scrollHeight - h, window.scrollY + ${sign} * Math.round(h * 0.85))); ${SMOOTH_SCROLL_BODY} const willHitBottom = ${sign} === 1 && targetY + h >= document.body.scrollHeight - 4; return JSON.stringify({ ok:true, detail:'Scrolled ${dir}' + (willHitBottom ? ' (reached bottom).' : '.') }); })()`;
};

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const safeCall = <T,>(fn: () => T, fallback: T): T => {
	try {
		return fn();
	} catch {
		return fallback;
	}
};

/**
 * Load a URL and resolve once the page settles (or a 20s cap, so a hung load
 * can't pin the agent's command). Resolves on the first `did-stop-loading`
 * or `did-fail-load` after the load starts.
 */
/** Wait for the next `did-stop-loading` (or a 15s cap) after a history nav. */
function waitForStop(wv: WebviewElement): Promise<void> {
	return new Promise<void>((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			wv.removeEventListener("did-stop-loading", finish);
			wv.removeEventListener("did-fail-load", finish);
			resolve();
		};
		wv.addEventListener("did-stop-loading", finish);
		wv.addEventListener("did-fail-load", finish);
		setTimeout(finish, 15000);
	});
}

function loadAndWait(wv: WebviewElement, url: string): Promise<void> {
	return new Promise<void>((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			wv.removeEventListener("did-stop-loading", finish);
			wv.removeEventListener("did-fail-load", finish);
			resolve();
		};
		wv.addEventListener("did-stop-loading", finish);
		wv.addEventListener("did-fail-load", finish);
		try {
			void wv.loadURL(url).catch(() => finish());
		} catch {
			wv.src = url;
		}
		setTimeout(finish, 20000);
	});
}

function BrowserAgentOverlay({
	shapes,
}: {
	shapes: ReadonlyArray<BrowserOverlayShape>;
}) {
	if (shapes.length === 0) return null;
	return (
		<svg
			className="pointer-events-none absolute inset-0 z-[15] h-full w-full overflow-visible"
			aria-hidden="true"
		>
			<defs>
				<marker
					id="browser-agent-arrow"
					markerWidth="8"
					markerHeight="8"
					refX="7"
					refY="4"
					orient="auto"
				>
					<path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" />
				</marker>
			</defs>
			{shapes.map((shape) => {
				const color = shape.color ?? "rgb(37 99 235)";
				switch (shape._tag) {
					case "Rectangle":
						return (
							<rect
								key={shape.id}
								x={shape.x}
								y={shape.y}
								width={shape.width}
								height={shape.height}
								fill="none"
								stroke={color}
								strokeWidth={3}
								rx={4}
							/>
						);
					case "Highlight":
						return (
							<rect
								key={shape.id}
								x={shape.x}
								y={shape.y}
								width={shape.width}
								height={shape.height}
								fill={color}
								fillOpacity={0.22}
								stroke={color}
								strokeWidth={1}
								rx={3}
							/>
						);
					case "Arrow":
						return (
							<line
								key={shape.id}
								x1={shape.fromX}
								y1={shape.fromY}
								x2={shape.toX}
								y2={shape.toY}
								stroke={color}
								strokeWidth={3}
								strokeLinecap="round"
								markerEnd="url(#browser-agent-arrow)"
							/>
						);
					case "Label":
						return (
							<g key={shape.id} transform={`translate(${shape.x} ${shape.y})`}>
								<rect
									x={0}
									y={-22}
									width={Math.max(44, shape.text.length * 7 + 16)}
									height={28}
									rx={6}
									fill={color}
								/>
								<text x={8} y={-4} fill="white" fontSize={12} fontWeight={600}>
									{shape.text}
								</text>
							</g>
						);
					case "Freehand":
						return (
							<path
								key={shape.id}
								d={pathFromPoints(shape.points)}
								fill="none"
								stroke={color}
								strokeWidth={3}
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						);
				}
				return null;
			})}
		</svg>
	);
}

function BrowserEmptyState({
	servers,
	onOpen,
}: {
	servers: ReadonlyArray<LocalServerSummary>;
	onOpen: (url: string) => void;
}) {
	const rows = servers.length > 0 ? servers : fallbackLocalServers;
	return (
		<div className="absolute inset-0 z-10 overflow-auto bg-background px-8 py-10">
			<div className="mx-auto max-w-3xl">
				<div className="mb-5 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
					<Server className="size-4" strokeWidth={1.8} />
					Local servers
				</div>
				<div className="overflow-hidden rounded-xl border border-border/70 bg-card/70">
					{rows.map((server) => (
						<button
							key={`${server.name}-${server.port}`}
							type="button"
							onClick={() => onOpen(`http://localhost:${server.port}`)}
							className="flex w-full items-center gap-4 border-b border-border/60 px-4 py-3 text-left last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						>
							<span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background text-muted-foreground">
								<Server className="size-4" strokeWidth={1.8} />
							</span>
							<span className="grid min-w-0 flex-1">
								<span className="truncate text-sm font-semibold text-foreground">
									{server.name}
								</span>
								<span className="text-sm text-muted-foreground">
									localhost:{server.port}
								</span>
							</span>
							<span className="size-2.5 rounded-full bg-emerald-500" />
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

function BrowserAnnotationOverlay({
	tool,
	setTool,
	hoverPick,
	elements,
	regions,
	strokes,
	dragRect,
	activeStroke,
	bounds,
	comment,
	setComment,
	canAttach,
	attaching,
	onAttach,
	onCancel,
	onPointerDown,
	onPointerMove,
	onPointerUp,
}: {
	tool: AnnotationTool;
	setTool: (tool: AnnotationTool) => void;
	hoverPick: BrowserElementPick | null;
	elements: ReadonlyArray<BrowserElementPick>;
	regions: ReadonlyArray<BrowserAnnotationRegion>;
	strokes: ReadonlyArray<BrowserAnnotationStroke>;
	dragRect: BrowserAnnotationRect | null;
	activeStroke: BrowserAnnotationStroke | null;
	bounds: BrowserAnnotationRect | null;
	comment: string;
	setComment: (value: string) => void;
	canAttach: boolean;
	attaching: boolean;
	onAttach: () => void;
	onCancel: () => void;
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
	const maxLeft =
		typeof window === "undefined" ? 16 : Math.max(16, window.innerWidth - 452);
	const maxTop =
		typeof window === "undefined" ? 16 : Math.max(16, window.innerHeight - 92);
	const editorStyle =
		bounds === null
			? { left: "50%", top: "58%", transform: "translate(-50%, -50%)" }
			: {
					left: Math.min(
						Math.max(16, bounds.x + Math.max(0, bounds.width - 360)),
						maxLeft,
					),
					top: Math.min(Math.max(16, bounds.y + bounds.height + 12), maxTop),
					transform: "translate(0, 0)",
				};

	return (
		<div
			className="absolute inset-0 z-20 cursor-crosshair bg-black/[0.03]"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
		>
			<div
				className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border/70 bg-background/95 p-1 shadow-lg backdrop-blur"
				onPointerDown={(event) => event.stopPropagation()}
			>
				{annotationTools.map((item) => {
					const Icon = item.icon;
					const active = item.id === tool;
					return (
						<button
							key={item.id}
							type="button"
							onClick={() => setTool(item.id)}
							className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium ${
								active
									? "bg-primary/10 text-primary"
									: "text-foreground hover:bg-muted"
							}`}
						>
							<Icon className="size-3.5" strokeWidth={1.8} />
							{item.label}
						</button>
					);
				})}
				<button
					type="button"
					onClick={onCancel}
					className="ml-1 flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
					aria-label="Cancel annotation"
				>
					<X className="size-4" strokeWidth={1.8} />
				</button>
			</div>

			{hoverPick !== null && tool === "select" ? (
				<AnnotationRect
					rect={hoverPick.rect}
					label={hoverPick.tagName}
					subtle
				/>
			) : null}
			{elements.map((element) => (
				<AnnotationRect
					key={element.id}
					rect={element.rect}
					label={element.tagName}
				/>
			))}
			{regions.map((region) => (
				<AnnotationRect key={region.id} rect={region.rect} label="region" />
			))}
			{dragRect !== null ? (
				<AnnotationRect rect={dragRect} label="region" subtle />
			) : null}

			<svg
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
			>
				{strokes.map((stroke) => (
					<path
						key={stroke.id}
						d={pathFromPoints(stroke.points)}
						fill="none"
						stroke="rgb(37 99 235)"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={3}
					/>
				))}
				{activeStroke !== null ? (
					<path
						d={pathFromPoints(activeStroke.points)}
						fill="none"
						stroke="rgb(37 99 235)"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={3}
					/>
				) : null}
			</svg>

			{bounds !== null ? (
				<div
					className="absolute flex w-[min(420px,calc(100%-32px))] items-start gap-2 rounded-xl border border-border/70 bg-background/95 p-2 shadow-xl backdrop-blur"
					style={editorStyle}
					onPointerDown={(event) => event.stopPropagation()}
				>
					<button
						type="button"
						className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
						aria-label="Annotation details"
					>
						<MousePointerClick className="size-4" strokeWidth={1.8} />
					</button>
					<textarea
						value={comment}
						onChange={(event) => setComment(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey && canAttach) {
								event.preventDefault();
								onAttach();
							}
						}}
						placeholder="Describe the change..."
						rows={1}
						className="min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground"
					/>
					<button
						type="button"
						onClick={onAttach}
						disabled={!canAttach || attaching}
						className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
					>
						<SendHorizontal className="size-3.5" strokeWidth={1.8} />
						{attaching ? "Attaching" : "Attach"}
					</button>
				</div>
			) : null}
		</div>
	);
}

function AnnotationRect({
	rect,
	label,
	subtle = false,
}: {
	rect: BrowserAnnotationRect;
	label: string;
	subtle?: boolean;
}) {
	return (
		<>
			<div
				className={`pointer-events-none absolute rounded border-2 ${
					subtle
						? "border-primary/80 bg-primary/10"
						: "border-primary bg-primary/20"
				}`}
				style={{
					left: rect.x,
					top: rect.y,
					width: rect.width,
					height: rect.height,
				}}
			/>
			<div
				className="pointer-events-none absolute rounded-md bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground shadow"
				style={{
					left: Math.max(4, rect.x),
					top: Math.max(4, rect.y - 24),
				}}
			>
				{label}
			</div>
		</>
	);
}

function ToolbarButton({
	onClick,
	disabled,
	ariaLabel,
	children,
}: {
	onClick: () => void;
	disabled: boolean;
	ariaLabel: string;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={ariaLabel}
			className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
		>
			{children}
		</button>
	);
}

// Best-effort URL normalization: a string with a scheme passes through,
// bare host[:port][/path] becomes https://… (except localhost / IP literals
// which default to http so dev servers work without typing the scheme).
function resolveUrl(input: string): string | null {
	const trimmed = input.trim();
	if (trimmed === "") return null;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
	const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(
		trimmed,
	);
	return `${isLocal ? "http" : "https"}://${trimmed}`;
}

// Minimal surface of Electron's WebviewTag we actually use. Keeps the file
// free of an `electron` import in the renderer (renderer is sandboxed and
// imports from `electron` would land us in preload territory).
type WebviewElement = HTMLElement & {
	src: string;
	loadURL: (url: string) => Promise<void>;
	reload: () => void;
	stop: () => void;
	goBack: () => void;
	goForward: () => void;
	canGoBack: () => boolean;
	canGoForward: () => boolean;
	getURL: () => string;
	getTitle: () => string;
	/**
	 * The embedded webContents id used by `webContents.fromId` on the main
	 * side. Required so main can attach CDP and route real input events.
	 */
	getWebContentsId: () => number;
	capturePage: () => Promise<NativeImageLike>;
	executeJavaScript: (code: string) => Promise<unknown>;
};

// Minimal surface of Electron's NativeImage we touch from the renderer.
// `toDataURL` keeps us off `Buffer`, which the sandboxed renderer lacks.
type NativeImageLike = {
	toDataURL: () => string;
	toPNG: () => Uint8Array | ArrayBuffer;
	isEmpty: () => boolean;
};
