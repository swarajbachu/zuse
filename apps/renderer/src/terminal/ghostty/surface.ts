import { copyText } from "../../lib/platform-capabilities.ts";
import {
	GhosttyEmulator,
	type Rgb,
	type TerminalFrame,
	type TerminalPalette,
	type TerminalSelectionInput,
} from "./emulator.ts";
import { ghosttyClipboardShortcut, ghosttyModifiers } from "./key-map.ts";

type Disposable = Readonly<{ dispose: () => void }>;
type DataListener = (data: string) => void;
type ResizeListener = (size: Readonly<{ cols: number; rows: number }>) => void;

const FONT_SIZE = 11;
const LINE_HEIGHT = 1.3;
const PADDING_X = 4;
const PADDING_Y = 2;
const SCROLL_ROWS = 3;
const SELECTION_AUTOSCROLL_EDGE_PX = 3;
const SELECTION_AUTOSCROLL_INTERVAL_MS = 50;

const cssRgb = ({ r, g, b }: Rgb): string => `rgb(${r} ${g} ${b})`;
const sameRgb = (left: Rgb, right: Rgb): boolean =>
	left.r === right.r && left.g === right.g && left.b === right.b;

function parseColor(value: string, fallback: Rgb): Rgb {
	const numbers = value.match(/[\d.]+/g)?.map(Number);
	if (numbers === undefined || numbers.length < 3) return fallback;
	return {
		r: Math.max(0, Math.min(255, Math.round(numbers[0] ?? fallback.r))),
		g: Math.max(0, Math.min(255, Math.round(numbers[1] ?? fallback.g))),
		b: Math.max(0, Math.min(255, Math.round(numbers[2] ?? fallback.b))),
	};
}

function readToken(host: HTMLElement, token: string, fallback: Rgb): Rgb {
	const probe = document.createElement("span");
	probe.style.cssText = `position:absolute;visibility:hidden;color:var(${token})`;
	host.appendChild(probe);
	const value = getComputedStyle(probe).color;
	probe.remove();
	return parseColor(value, fallback);
}

function ghosttyMouseButton(button: number): number | null {
	switch (button) {
		case 0:
			return 1;
		case 1:
			return 3;
		case 2:
			return 2;
		case 3:
			return 4;
		case 4:
			return 5;
		default:
			return null;
	}
}

export function terminalPalette(host: HTMLElement): TerminalPalette {
	return {
		background: readToken(host, "--background", { r: 11, g: 11, b: 12 }),
		foreground: readToken(host, "--foreground", { r: 230, g: 230, b: 230 }),
		cursor: readToken(host, "--primary", { r: 230, g: 230, b: 230 }),
		selection:
			getComputedStyle(host).getPropertyValue("--accent").trim() || "#2c2c33",
		selectionForeground: readToken(host, "--accent-foreground", {
			r: 230,
			g: 230,
			b: 230,
		}),
	};
}

export class GhosttySurface {
	readonly host: HTMLDivElement;
	cols = 80;
	rows = 24;

	private readonly canvas: HTMLCanvasElement;
	private readonly input: HTMLTextAreaElement;
	private readonly accessibility: HTMLPreElement;
	private readonly context: CanvasRenderingContext2D;
	private readonly dataListeners = new Set<DataListener>();
	private readonly resizeListeners = new Set<ResizeListener>();
	private readonly suppressedKeyUps = new Set<string>();
	private readonly emulatorPromise: Promise<GhosttyEmulator>;
	private emulator: GhosttyEmulator | null = null;
	private frame: TerminalFrame | null = null;
	private palette: TerminalPalette;
	private cellWidth = 7;
	private cellHeight = Math.ceil(FONT_SIZE * LINE_HEIGHT);
	private writeChain: Promise<void> = Promise.resolve();
	private paintRequest: number | null = null;
	private cursorTimer: ReturnType<typeof setTimeout> | null = null;
	private cursorOn = true;
	private selectionAnchor: { x: number; y: number } | null = null;
	private selectionAutoscrollInput: TerminalSelectionInput | null = null;
	private selectionAutoscrollTimer: ReturnType<typeof setInterval> | null =
		null;
	private reportingPointer: number | null = null;
	private reportedButton: number | null = null;
	private forceFullPaint = true;
	private disposed = false;
	private readonly handleWindowBlur = (): void => {
		this.stopSelectionAutoscroll();
		this.emitFocus(false);
	};
	private readonly handleWindowFocus = (): void => {
		this.emitFocus(this.terminalHasFocus());
	};

	constructor() {
		this.host = document.createElement("div");
		this.host.className =
			"relative h-full w-full overflow-hidden bg-background";
		this.host.dataset.terminalRenderer = "ghostty";
		this.host.setAttribute("role", "application");
		this.host.setAttribute("aria-label", "Terminal");

		this.canvas = document.createElement("canvas");
		this.canvas.className = "block h-full w-full cursor-text";
		this.canvas.tabIndex = -1;
		const context = this.canvas.getContext("2d", { alpha: false });
		if (context === null) throw new Error("Canvas 2D is unavailable");
		this.context = context;

		this.input = document.createElement("textarea");
		this.input.setAttribute("aria-label", "Terminal input");
		this.input.autocapitalize = "off";
		this.input.autocomplete = "off";
		this.input.spellcheck = false;
		this.input.style.cssText =
			"position:absolute;left:4px;top:2px;width:1px;height:1px;opacity:0;resize:none;overflow:hidden;pointer-events:none";

		this.accessibility = document.createElement("pre");
		this.accessibility.className = "sr-only";
		this.accessibility.setAttribute("aria-live", "polite");
		this.accessibility.setAttribute("aria-atomic", "true");

		this.host.append(this.canvas, this.input, this.accessibility);
		this.palette = terminalPalette(this.host);
		this.bindEvents();
		this.emulatorPromise = GhosttyEmulator.create(this.palette, (data) => {
			for (const listener of this.dataListeners) listener(data);
		}).then((emulator) => {
			if (this.disposed) {
				emulator.dispose();
				throw new Error("Terminal surface was disposed during initialization");
			}
			this.emulator = emulator;
			this.fit();
			this.schedulePaint();
			return emulator;
		});
		// Readiness is surfaced explicitly through `ready()`. Keep one permanent
		// rejection observer as well so disposal or a caller that never reaches the
		// PTY boundary cannot turn an initialization failure into an unhandled
		// process-level rejection.
		void this.emulatorPromise.catch(() => undefined);
	}

	open(container: HTMLElement): void {
		container.appendChild(this.host);
		this.fit();
	}

	onData(listener: DataListener): Disposable {
		this.dataListeners.add(listener);
		return { dispose: () => this.dataListeners.delete(listener) };
	}

	onResize(listener: ResizeListener): Disposable {
		this.resizeListeners.add(listener);
		return { dispose: () => this.resizeListeners.delete(listener) };
	}

	/** Resolves only after the Ghostty WASM emulator is ready for PTY output. */
	ready(): Promise<void> {
		return this.emulatorPromise.then(() => undefined);
	}

	write(data: string): Promise<void> {
		this.writeChain = this.writeChain.then(async () => {
			const emulator = await this.emulatorPromise;
			emulator.write(data);
			// A program may enable mode 1004 while the textarea is already focused.
			// Re-check after every feed; the emulator deduplicates unchanged reports.
			this.emitData(emulator.encodeFocus(this.terminalHasFocus()));
			this.schedulePaint();
		});
		return this.writeChain;
	}

	reset(): Promise<void> {
		this.writeChain = this.writeChain.then(async () => {
			const emulator = await this.emulatorPromise;
			emulator.reset();
			this.frame = null;
			this.forceFullPaint = true;
			this.schedulePaint();
		});
		return this.writeChain;
	}

	fit(): void {
		if (this.disposed || !this.host.isConnected) return;
		const width = this.host.clientWidth;
		const height = this.host.clientHeight;
		if (width <= 0 || height <= 0) return;
		this.context.font = this.font(false, false);
		this.cellWidth = Math.max(
			1,
			Math.ceil(this.context.measureText("M").width),
		);
		this.cellHeight = Math.max(1, Math.ceil(FONT_SIZE * LINE_HEIGHT));
		const cols = Math.max(
			1,
			Math.floor((width - PADDING_X * 2) / this.cellWidth),
		);
		const rows = Math.max(
			1,
			Math.floor((height - PADDING_Y * 2) / this.cellHeight),
		);
		const ratio = window.devicePixelRatio || 1;
		const pixelWidth = Math.max(1, Math.round(width * ratio));
		const pixelHeight = Math.max(1, Math.round(height * ratio));
		if (
			this.canvas.width !== pixelWidth ||
			this.canvas.height !== pixelHeight
		) {
			this.canvas.width = pixelWidth;
			this.canvas.height = pixelHeight;
			this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
			this.forceFullPaint = true;
		}
		const gridChanged = cols !== this.cols || rows !== this.rows;
		this.cols = cols;
		this.rows = rows;
		void this.emulatorPromise.then(
			(emulator) => {
				if (this.disposed) return;
				emulator.resize(
					cols,
					rows,
					this.cellWidth,
					this.cellHeight,
					width,
					height,
					PADDING_X,
					PADDING_Y,
				);
				this.schedulePaint();
				if (gridChanged) {
					for (const listener of this.resizeListeners) listener({ cols, rows });
				}
			},
			() => undefined,
		);
	}

	focus(): void {
		this.input.focus({ preventScroll: true });
	}

	refreshTheme(): void {
		this.palette = terminalPalette(this.host);
		this.forceFullPaint = true;
		void this.emulatorPromise.then(
			(emulator) => {
				if (this.disposed) return;
				emulator.setPalette(this.palette);
				this.schedulePaint();
			},
			() => undefined,
		);
	}

	find(query: string): boolean {
		const needle = query.toLocaleLowerCase();
		if (needle.length === 0 || this.frame === null) return false;
		return this.frame.lines.some((line) =>
			line
				.map((glyph) => glyph.text || " ")
				.join("")
				.toLocaleLowerCase()
				.includes(needle),
		);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.paintRequest !== null) cancelAnimationFrame(this.paintRequest);
		if (this.cursorTimer !== null) clearTimeout(this.cursorTimer);
		this.stopSelectionAutoscroll();
		this.paintRequest = null;
		this.cursorTimer = null;
		window.removeEventListener("blur", this.handleWindowBlur);
		window.removeEventListener("focus", this.handleWindowFocus);
		this.dataListeners.clear();
		this.resizeListeners.clear();
		this.emulator?.dispose();
		this.emulator = null;
		this.host.remove();
	}

	private bindEvents(): void {
		window.addEventListener("blur", this.handleWindowBlur);
		window.addEventListener("focus", this.handleWindowFocus);
		this.input.addEventListener("focus", () => this.emitFocus(true));
		this.input.addEventListener("blur", () => {
			this.stopSelectionAutoscroll();
			this.emitFocus(false);
		});
		this.host.addEventListener("pointerdown", (event) => {
			// Keep the hidden keyboard input focused. Otherwise the browser's
			// subsequent mousedown focuses the canvas and typing stops working.
			event.preventDefault();
			this.focus();
			if (this.emulator === null) return;
			const point = this.cellAt(event);
			if ((event.metaKey || event.ctrlKey) && event.button === 0) {
				const link = this.emulator.hyperlinkAt(point.x, point.y);
				if (link !== null) {
					window.open(link, "_blank", "noopener,noreferrer");
					return;
				}
			}
			const button = ghosttyMouseButton(event.button);
			if (!event.shiftKey && button !== null && this.emulator.mouseTracking()) {
				const point = this.surfacePoint(event);
				this.emitData(
					this.emulator.encodeMouse({
						action: "press",
						button,
						modifiers: ghosttyModifiers(event),
						x: point.x,
						y: point.y,
						anyButtonPressed: true,
					}),
				);
				this.reportingPointer = event.pointerId;
				this.reportedButton = button;
				this.canvas.setPointerCapture(event.pointerId);
				return;
			}
			if (event.button !== 0) return;
			this.selectionAnchor = point;
			const surfacePoint = this.surfacePoint(event);
			this.emulator.selectionPress({
				x: point.x,
				y: point.y,
				surfaceX: surfacePoint.x,
				surfaceY: surfacePoint.y,
				timeMs: event.timeStamp,
				rectangle: event.altKey,
			});
			this.canvas.setPointerCapture(event.pointerId);
			this.schedulePaint();
		});
		this.host.addEventListener("pointermove", (event) => {
			if (this.emulator === null) return;
			if (
				this.selectionAnchor === null &&
				!event.shiftKey &&
				this.emulator.mouseTracking()
			) {
				const point = this.surfacePoint(event);
				this.emitData(
					this.emulator.encodeMouse({
						action: "motion",
						button: this.reportedButton,
						modifiers: ghosttyModifiers(event),
						x: point.x,
						y: point.y,
						anyButtonPressed: this.reportedButton !== null,
					}),
				);
				return;
			}
			if (this.selectionAnchor === null) return;
			const point = this.cellAt(event);
			const surfacePoint = this.surfacePoint(event);
			this.emulator.selectionDrag({
				x: point.x,
				y: point.y,
				surfaceX: surfacePoint.x,
				surfaceY: surfacePoint.y,
				timeMs: event.timeStamp,
				rectangle: event.altKey,
			});
			this.updateSelectionAutoscroll({
				x: point.x,
				y: point.y,
				surfaceX: surfacePoint.x,
				surfaceY: surfacePoint.y,
				timeMs: event.timeStamp,
				rectangle: event.altKey,
			});
			this.schedulePaint();
		});
		this.host.addEventListener("pointerup", (event) => {
			this.stopSelectionAutoscroll();
			if (this.releaseReportedPointer(event)) event.preventDefault();
			if (this.emulator !== null && this.selectionAnchor !== null) {
				this.emulator.selectionRelease(this.cellAt(event));
			}
			this.selectionAnchor = null;
			if (this.canvas.hasPointerCapture(event.pointerId)) {
				this.canvas.releasePointerCapture(event.pointerId);
			}
		});
		this.host.addEventListener("pointercancel", (event) => {
			this.stopSelectionAutoscroll();
			this.releaseReportedPointer(event);
			if (this.emulator !== null && this.selectionAnchor !== null) {
				this.emulator.selectionRelease(null);
			}
			this.selectionAnchor = null;
		});
		this.host.addEventListener(
			"wheel",
			(event) => {
				if (this.emulator === null) return;
				if (!event.shiftKey && this.emulator.mouseTracking()) {
					const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
					const button = vertical
						? event.deltaY < 0
							? 4
							: 5
						: event.deltaX < 0
							? 6
							: 7;
					const point = this.surfacePoint(event);
					const encoded = this.emulator.encodeMouse({
						action: "press",
						button,
						modifiers: ghosttyModifiers(event),
						x: point.x,
						y: point.y,
						anyButtonPressed: false,
					});
					if (encoded.length > 0) {
						this.emitData(encoded);
						event.preventDefault();
						return;
					}
				}
				this.emulator.scroll(Math.sign(event.deltaY) * SCROLL_ROWS);
				this.schedulePaint();
				event.preventDefault();
			},
			{ passive: false },
		);
		this.input.addEventListener("keydown", (event) => {
			if (this.emulator === null || event.isComposing) return;
			const clipboardShortcut = ghosttyClipboardShortcut(event);
			if (clipboardShortcut !== null) {
				this.suppressedKeyUps.add(event.code || event.key);
				if (clipboardShortcut === "paste") {
					// Leave the browser default enabled: it dispatches the trusted paste
					// event below without requiring clipboard-read permission.
					return;
				}
				if (clipboardShortcut === "select-all") {
					if (this.emulator.selectAll()) this.schedulePaint();
					event.preventDefault();
					return;
				}
				const selection = this.emulator.selectionText();
				if (selection.length > 0) {
					void copyText(selection).catch(() => undefined);
				}
				event.preventDefault();
				return;
			}
			const data = this.emulator.encodeKey(event);
			if (data.length === 0) return;
			for (const listener of this.dataListeners) listener(data);
			event.preventDefault();
		});
		this.input.addEventListener("keyup", (event) => {
			if (this.emulator === null || event.isComposing) return;
			if (this.suppressedKeyUps.delete(event.code || event.key)) {
				event.preventDefault();
				return;
			}
			const data = this.emulator.encodeKey(event, true);
			if (data.length > 0) {
				for (const listener of this.dataListeners) listener(data);
			}
		});
		this.input.addEventListener("compositionend", (event) => {
			if (event.data.length === 0) return;
			for (const listener of this.dataListeners) listener(event.data);
			this.input.value = "";
		});
		this.input.addEventListener("paste", (event) => {
			if (this.emulator === null) return;
			const text = event.clipboardData?.getData("text") ?? "";
			const data = this.emulator.encodePaste(text);
			if (data.length > 0) {
				for (const listener of this.dataListeners) listener(data);
			}
			event.preventDefault();
		});
	}

	private terminalHasFocus(): boolean {
		return (
			document.activeElement === this.input &&
			(typeof document.hasFocus !== "function" || document.hasFocus())
		);
	}

	private emitFocus(focused: boolean): void {
		if (this.emulator === null || this.disposed) return;
		this.emitData(this.emulator.encodeFocus(focused));
	}

	private updateSelectionAutoscroll(input: TerminalSelectionInput): void {
		const height = this.canvas.getBoundingClientRect().height;
		if (
			input.surfaceY > SELECTION_AUTOSCROLL_EDGE_PX &&
			input.surfaceY <= height - SELECTION_AUTOSCROLL_EDGE_PX
		) {
			this.stopSelectionAutoscroll();
			return;
		}
		this.selectionAutoscrollInput = input;
		if (this.selectionAutoscrollTimer !== null) return;
		this.selectionAutoscrollTimer = setInterval(
			() => this.performSelectionAutoscroll(),
			SELECTION_AUTOSCROLL_INTERVAL_MS,
		);
	}

	private performSelectionAutoscroll(): void {
		const input = this.selectionAutoscrollInput;
		if (
			this.disposed ||
			!this.host.isConnected ||
			this.emulator === null ||
			this.selectionAnchor === null ||
			input === null ||
			!this.emulator.selectionAutoscrollTick(input)
		) {
			this.stopSelectionAutoscroll();
			return;
		}
		this.schedulePaint();
	}

	private stopSelectionAutoscroll(): void {
		if (this.selectionAutoscrollTimer !== null) {
			clearInterval(this.selectionAutoscrollTimer);
		}
		this.selectionAutoscrollTimer = null;
		this.selectionAutoscrollInput = null;
	}

	private emitData(data: string): void {
		if (data.length === 0) return;
		for (const listener of this.dataListeners) listener(data);
	}

	private releaseReportedPointer(event: PointerEvent): boolean {
		if (
			this.emulator === null ||
			this.reportingPointer !== event.pointerId ||
			this.reportedButton === null
		) {
			return false;
		}
		const point = this.surfacePoint(event);
		this.emitData(
			this.emulator.encodeMouse({
				action: "release",
				button: this.reportedButton,
				modifiers: ghosttyModifiers(event),
				x: point.x,
				y: point.y,
				anyButtonPressed: false,
			}),
		);
		this.reportingPointer = null;
		this.reportedButton = null;
		return true;
	}

	private surfacePoint(event: MouseEvent | PointerEvent): {
		x: number;
		y: number;
	} {
		const bounds = this.canvas.getBoundingClientRect();
		return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
	}

	private cellAt(event: MouseEvent | PointerEvent): { x: number; y: number } {
		const bounds = this.canvas.getBoundingClientRect();
		return {
			x: Math.max(
				0,
				Math.min(
					this.cols - 1,
					Math.floor(
						(event.clientX - bounds.left - PADDING_X) / this.cellWidth,
					),
				),
			),
			y: Math.max(
				0,
				Math.min(
					this.rows - 1,
					Math.floor(
						(event.clientY - bounds.top - PADDING_Y) / this.cellHeight,
					),
				),
			),
		};
	}

	private schedulePaint(): void {
		if (this.paintRequest !== null || this.disposed || !this.host.isConnected)
			return;
		this.paintRequest = requestAnimationFrame(() => {
			this.paintRequest = null;
			this.paint();
		});
	}

	private paint(): void {
		if (this.emulator === null || this.disposed || this.host.clientWidth === 0)
			return;
		const previous = this.frame;
		const frame = this.emulator.capture();
		this.frame = frame;
		const context = this.context;
		const fullPaint =
			this.forceFullPaint ||
			previous === null ||
			previous.cols !== frame.cols ||
			previous.rows !== frame.rows ||
			!sameRgb(previous.background, frame.background);
		const dirtyRows = new Set<number>();
		if (fullPaint) {
			for (let row = 0; row < frame.lines.length; row += 1) dirtyRows.add(row);
		} else {
			for (let row = 0; row < frame.lines.length; row += 1) {
				if (frame.lines[row] !== previous.lines[row]) dirtyRows.add(row);
			}
			if (previous.cursorY >= 0) dirtyRows.add(previous.cursorY);
			if (frame.cursorY >= 0) dirtyRows.add(frame.cursorY);
		}
		if (frame.hasBlinkingText) {
			for (let row = 0; row < frame.lines.length; row += 1) {
				if (frame.lines[row]?.some((glyph) => glyph.blink)) dirtyRows.add(row);
			}
		}
		context.save();
		if (fullPaint) {
			context.fillStyle = cssRgb(frame.background);
			context.fillRect(0, 0, this.host.clientWidth, this.host.clientHeight);
		}
		context.textBaseline = "top";
		for (const row of dirtyRows) this.drawRow(frame, row);
		if (frame.cursorVisible && (!frame.cursorBlinking || this.cursorOn)) {
			this.drawCursor(frame);
		}
		context.restore();
		this.forceFullPaint = false;
		if (frame !== previous) {
			this.accessibility.textContent = frame.lines
				.map((line) =>
					line
						.map((glyph) => glyph.text || " ")
						.join("")
						.trimEnd(),
				)
				.join("\n");
		}
		this.scheduleCursor(
			(frame.cursorBlinking && frame.cursorVisible) || frame.hasBlinkingText,
		);
	}

	private drawRow(frame: TerminalFrame, row: number): void {
		const line = frame.lines[row];
		if (line === undefined) return;
		for (let col = 0; col < line.length; col += 1) {
			const glyph = line[col];
			if (glyph === undefined) continue;
			this.context.fillStyle = glyph.selected
				? this.palette.selection
				: cssRgb(glyph.background);
			this.context.fillRect(
				PADDING_X + col * this.cellWidth,
				PADDING_Y + row * this.cellHeight,
				this.cellWidth,
				this.cellHeight,
			);
		}
		for (let col = 0; col < line.length; col += 1) {
			const glyph = line[col];
			if (glyph === undefined) continue;
			const x = PADDING_X + col * this.cellWidth;
			const y = PADDING_Y + row * this.cellHeight;
			if (glyph.text.length === 0 || (glyph.blink && !this.cursorOn)) continue;
			const foreground = glyph.selected
				? this.palette.selectionForeground
				: glyph.foreground;
			this.context.font = this.font(glyph.bold, glyph.italic);
			this.context.fillStyle = cssRgb(foreground);
			this.context.globalAlpha = glyph.faint ? 0.55 : 1;
			this.context.fillText(glyph.text, x, y + 1);
			if (glyph.overline) this.drawLine(x, y + 1.5, foreground);
			if (glyph.strikethrough) {
				this.drawLine(x, y + Math.floor(this.cellHeight / 2) + 0.5, foreground);
			}
			if (glyph.underlineStyle !== 0) {
				this.drawUnderline(
					x,
					y + this.cellHeight - 2.5,
					glyph.selected ? foreground : glyph.underlineColor,
					glyph.underlineStyle,
				);
			}
			this.context.globalAlpha = 1;
		}
	}

	private drawLine(x: number, y: number, color: Rgb): void {
		this.context.strokeStyle = cssRgb(color);
		this.context.lineWidth = 1;
		this.context.beginPath();
		this.context.moveTo(x, y);
		this.context.lineTo(x + this.cellWidth, y);
		this.context.stroke();
	}

	private drawUnderline(x: number, y: number, color: Rgb, style: number): void {
		this.context.strokeStyle = cssRgb(color);
		this.context.lineWidth = 1;
		if (style === 2) {
			this.drawLine(x, y - 2, color);
			this.drawLine(x, y, color);
			return;
		}
		if (style === 3) {
			this.context.beginPath();
			this.context.moveTo(x, y);
			for (let offset = 0; offset < this.cellWidth; offset += 2) {
				this.context.quadraticCurveTo(
					x + offset + 1,
					y + (offset % 4 === 0 ? 1.5 : -1.5),
					x + Math.min(this.cellWidth, offset + 2),
					y,
				);
			}
			this.context.stroke();
			return;
		}
		this.context.setLineDash(style === 4 ? [1, 2] : style === 5 ? [3, 2] : []);
		this.drawLine(x, y, color);
		this.context.setLineDash([]);
	}

	private drawCursor(frame: TerminalFrame): void {
		const x = PADDING_X + frame.cursorX * this.cellWidth;
		const y = PADDING_Y + frame.cursorY * this.cellHeight;
		this.context.strokeStyle = cssRgb(frame.cursor);
		this.context.fillStyle = cssRgb(frame.cursor);
		switch (frame.cursorStyle) {
			case 0:
				this.context.fillRect(x, y, 1, this.cellHeight);
				break;
			case 2:
				this.context.fillRect(x, y + this.cellHeight - 2, this.cellWidth, 2);
				break;
			case 3:
				this.context.strokeRect(
					x + 0.5,
					y + 0.5,
					this.cellWidth - 1,
					this.cellHeight - 1,
				);
				break;
			default:
				this.context.fillRect(x, y, this.cellWidth, this.cellHeight);
				this.drawCursorGlyph(frame, x, y);
		}
	}

	private drawCursorGlyph(frame: TerminalFrame, x: number, y: number): void {
		const glyph = frame.lines[frame.cursorY]?.[frame.cursorX];
		if (glyph === undefined || glyph.text.length === 0) return;
		this.context.font = this.font(glyph.bold, glyph.italic);
		this.context.fillStyle = cssRgb(frame.background);
		this.context.fillText(glyph.text, x, y + 1);
	}

	private scheduleCursor(enabled: boolean): void {
		if (!enabled) {
			this.cursorOn = true;
			if (this.cursorTimer !== null) clearTimeout(this.cursorTimer);
			this.cursorTimer = null;
			return;
		}
		if (this.cursorTimer !== null) return;
		this.cursorTimer = setTimeout(() => {
			this.cursorTimer = null;
			this.cursorOn = !this.cursorOn;
			this.schedulePaint();
		}, 530);
	}

	private font(bold: boolean, italic: boolean): string {
		return `${italic ? "italic" : "normal"} ${bold ? 600 : 400} ${FONT_SIZE}px "SF Mono", "JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;
	}
}
