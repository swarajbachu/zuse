import {
	consumedModifiers,
	ghosttyKeyCode,
	ghosttyModifiers,
	unshiftedCodepoint,
} from "./key-map.ts";
import { type GhosttyWasmRuntime, loadGhosttyWasm } from "./wasm-runtime.ts";

const OK = 0;
const OUT_OF_SPACE = -3;
const NO_VALUE = -4;
const CODEPOINT_SCRATCH_CAPACITY = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type Rgb = Readonly<{ r: number; g: number; b: number }>;

export type TerminalPalette = Readonly<{
	foreground: Rgb;
	background: Rgb;
	cursor: Rgb;
	selection: string;
	selectionForeground: Rgb;
}>;

export type TerminalGlyph = Readonly<{
	text: string;
	foreground: Rgb;
	background: Rgb;
	bold: boolean;
	italic: boolean;
	faint: boolean;
	blink: boolean;
	underlineStyle: number;
	underlineColor: Rgb;
	strikethrough: boolean;
	overline: boolean;
	selected: boolean;
}>;

export type TerminalFrame = Readonly<{
	cols: number;
	rows: number;
	lines: readonly (readonly TerminalGlyph[])[];
	foreground: Rgb;
	background: Rgb;
	cursor: Rgb;
	cursorX: number;
	cursorY: number;
	cursorVisible: boolean;
	cursorBlinking: boolean;
	cursorStyle: number;
	hasBlinkingText: boolean;
}>;

export type TerminalMouseInput = Readonly<{
	action: "press" | "release" | "motion";
	button: number | null;
	modifiers: number;
	x: number;
	y: number;
	anyButtonPressed: boolean;
}>;

export type TerminalSelectionInput = Readonly<{
	x: number;
	y: number;
	surfaceX: number;
	surfaceY: number;
	timeMs: number;
	rectangle: boolean;
}>;

type Handle = { slot: number; value: number; free: string };

class LifoResourceAuthority {
	private readonly releases: Array<() => void> = [];
	private released = false;

	add(release: () => void): void {
		if (this.released)
			throw new Error("Ghostty resource authority is released");
		this.releases.push(release);
	}

	release(): void {
		const failures = this.drain();
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, "Failed to release Ghostty resources");
		}
	}

	releasePreserving(original: unknown): never {
		this.drain();
		throw original;
	}

	private drain(): unknown[] {
		if (this.released) return [];
		this.released = true;
		const failures: unknown[] = [];
		while (this.releases.length > 0) {
			const release = this.releases.pop();
			if (release === undefined) continue;
			try {
				release();
			} catch (cause) {
				failures.push(cause);
			}
		}
		return failures;
	}
}

function assertGhostty(operation: string, result: number): void {
	if (result !== OK)
		throw new Error(`${operation} failed with Ghostty result ${result}`);
}

function rgb(view: Uint8Array, offset = 0): Rgb {
	return {
		r: view[offset] ?? 0,
		g: view[offset + 1] ?? 0,
		b: view[offset + 2] ?? 0,
	};
}

export class GhosttyEmulator {
	private readonly resources = new LifoResourceAuthority();
	private readonly runtime: GhosttyWasmRuntime;
	private readonly terminal!: Handle;
	private readonly renderState!: Handle;
	private readonly rows!: Handle;
	private readonly cells!: Handle;
	private readonly keyEncoder!: Handle;
	private readonly keyEvent!: Handle;
	private readonly mouseEncoder!: Handle;
	private readonly mouseEvent!: Handle;
	private readonly selectionGesture!: Handle;
	private readonly selectionPressEvent!: Handle;
	private readonly selectionDragEvent!: Handle;
	private readonly selectionAutoscrollEvent!: Handle;
	private readonly selectionReleaseEvent!: Handle;
	private readonly mouseSize!: number;
	private readonly mousePosition!: number;
	private readonly selectionGeometry!: number;
	private readonly selectionPosition!: number;
	private readonly selectionViewport!: number;
	private readonly selection!: number;
	private readonly scratch!: number;
	private readonly style!: number;
	private readonly codepoints!: number;
	private readonly colorPalette!: number;
	private palette: TerminalPalette;
	private frame: TerminalFrame | null = null;
	private focusReportingActive = false;
	private reportedFocus: boolean | null = null;
	private disposed = false;

	private constructor(
		runtime: GhosttyWasmRuntime,
		palette: TerminalPalette,
		onInput: (data: string) => void,
	) {
		this.runtime = runtime;
		this.palette = palette;
		try {
			this.scratch = this.acquireBuffer(32);
			this.style = this.acquireBuffer(runtime.layout("GhosttyStyle").size);
			this.codepoints = this.acquireBuffer(CODEPOINT_SCRATCH_CAPACITY * 4);
			this.colorPalette = this.acquireBuffer(256 * 3);

			const optionsLayout = runtime.layout("GhosttyTerminalOptions");
			const options = runtime.allocate(optionsLayout.size);
			try {
				runtime.writeField(options, "GhosttyTerminalOptions", "cols", 80);
				runtime.writeField(options, "GhosttyTerminalOptions", "rows", 24);
				runtime.writeField(
					options,
					"GhosttyTerminalOptions",
					"max_scrollback",
					10_000,
				);
				this.terminal = this.createHandle(
					"ghostty_terminal_new",
					"ghostty_terminal_free",
					options,
				);
			} finally {
				runtime.release(options, optionsLayout.size);
			}

			this.renderState = this.createHandle(
				"ghostty_render_state_new",
				"ghostty_render_state_free",
			);
			this.rows = this.createHandle(
				"ghostty_render_state_row_iterator_new",
				"ghostty_render_state_row_iterator_free",
			);
			this.cells = this.createHandle(
				"ghostty_render_state_row_cells_new",
				"ghostty_render_state_row_cells_free",
			);
			this.keyEncoder = this.createHandle(
				"ghostty_key_encoder_new",
				"ghostty_key_encoder_free",
			);
			this.keyEvent = this.createHandle(
				"ghostty_key_event_new",
				"ghostty_key_event_free",
			);
			this.mouseEncoder = this.createHandle(
				"ghostty_mouse_encoder_new",
				"ghostty_mouse_encoder_free",
			);
			this.mouseEvent = this.createHandle(
				"ghostty_mouse_event_new",
				"ghostty_mouse_event_free",
			);
			this.selectionGesture = this.createHandle(
				"ghostty_selection_gesture_new",
				"ghostty_selection_gesture_free",
				undefined,
				() => [this.terminal.value],
			);
			this.selectionPressEvent = this.createHandle(
				"ghostty_selection_gesture_event_new",
				"ghostty_selection_gesture_event_free",
				0,
			);
			this.selectionReleaseEvent = this.createHandle(
				"ghostty_selection_gesture_event_new",
				"ghostty_selection_gesture_event_free",
				1,
			);
			this.selectionDragEvent = this.createHandle(
				"ghostty_selection_gesture_event_new",
				"ghostty_selection_gesture_event_free",
				2,
			);
			this.selectionAutoscrollEvent = this.createHandle(
				"ghostty_selection_gesture_event_new",
				"ghostty_selection_gesture_event_free",
				3,
			);
			this.mouseSize = this.acquireBuffer(
				runtime.layout("GhosttyMouseEncoderSize").size,
			);
			this.mousePosition = this.acquireBuffer(
				runtime.layout("GhosttyMousePosition").size,
			);
			this.selectionGeometry = this.acquireBuffer(
				runtime.layout("GhosttySelectionGestureGeometry").size,
			);
			this.selectionPosition = this.acquireBuffer(
				runtime.layout("GhosttySurfacePosition").size,
			);
			this.selectionViewport = this.acquireBuffer(
				runtime.layout("GhosttyPointCoordinate").size,
			);
			this.selection = this.acquireBuffer(
				runtime.layout("GhosttySelection").size,
			);
			runtime.bytes(this.scratch, 1)[0] = 1;
			runtime.invoke(
				"ghostty_mouse_encoder_setopt",
				this.mouseEncoder.value,
				4,
				this.scratch,
			);
			runtime.invoke(
				"ghostty_mouse_encoder_setopt_from_terminal",
				this.mouseEncoder.value,
				this.terminal.value,
			);
			const detachReplies = runtime.registerTerminalReplies(
				this.terminal.value,
				(bytes) => {
					onInput(decoder.decode(bytes));
				},
			);
			this.resources.add(detachReplies);
			this.setPalette(palette);
		} catch (cause) {
			this.disposed = true;
			this.resources.releasePreserving(cause);
		}
	}

	static async create(
		palette: TerminalPalette,
		onInput: (data: string) => void,
	): Promise<GhosttyEmulator> {
		return new GhosttyEmulator(await loadGhosttyWasm(), palette, onInput);
	}

	write(data: string | Uint8Array): void {
		this.ensureAlive();
		const bytes = typeof data === "string" ? encoder.encode(data) : data;
		if (bytes.byteLength === 0) return;
		const pointer = this.runtime.allocate(bytes.byteLength);
		try {
			this.runtime.bytes(pointer, bytes.byteLength).set(bytes);
			this.runtime.invoke(
				"ghostty_terminal_vt_write",
				this.terminal.value,
				pointer,
				bytes.byteLength,
			);
			this.runtime.invoke(
				"ghostty_mouse_encoder_setopt_from_terminal",
				this.mouseEncoder.value,
				this.terminal.value,
			);
		} finally {
			this.runtime.release(pointer, bytes.byteLength);
		}
	}

	reset(): void {
		this.ensureAlive();
		this.runtime.invoke("ghostty_terminal_reset", this.terminal.value);
		this.runtime.invoke(
			"ghostty_mouse_encoder_setopt_from_terminal",
			this.mouseEncoder.value,
			this.terminal.value,
		);
		this.frame = null;
		this.focusReportingActive = false;
		this.reportedFocus = null;
	}

	resize(
		cols: number,
		rows: number,
		cellWidth: number,
		cellHeight: number,
		screenWidth = cols * cellWidth,
		screenHeight = rows * cellHeight,
		paddingX = 0,
		paddingY = 0,
	): void {
		this.ensureAlive();
		assertGhostty(
			"ghostty_terminal_resize",
			this.runtime.invoke(
				"ghostty_terminal_resize",
				this.terminal.value,
				Math.max(1, Math.min(65_535, Math.floor(cols))),
				Math.max(1, Math.min(65_535, Math.floor(rows))),
				Math.max(1, Math.round(cellWidth)),
				Math.max(1, Math.round(cellHeight)),
			),
		);
		const layout = this.runtime.layout("GhosttyMouseEncoderSize");
		for (const [field, value] of [
			["size", layout.size],
			["screen_width", screenWidth],
			["screen_height", screenHeight],
			["cell_width", cellWidth],
			["cell_height", cellHeight],
			["padding_top", paddingY],
			["padding_bottom", paddingY],
			["padding_right", paddingX],
			["padding_left", paddingX],
		] as const) {
			this.runtime.writeField(
				this.mouseSize,
				"GhosttyMouseEncoderSize",
				field,
				Math.max(0, Math.round(value)),
			);
		}
		this.runtime.invoke(
			"ghostty_mouse_encoder_setopt",
			this.mouseEncoder.value,
			2,
			this.mouseSize,
		);
		for (const [field, value] of [
			["columns", cols],
			["cell_width", cellWidth],
			["padding_left", paddingX],
			["screen_height", screenHeight],
		] as const) {
			this.runtime.writeField(
				this.selectionGeometry,
				"GhosttySelectionGestureGeometry",
				field,
				Math.max(0, Math.round(value)),
			);
		}
	}

	mouseTracking(): boolean {
		this.ensureAlive();
		this.runtime.bytes(this.scratch, 1)[0] = 0;
		return (
			this.runtime.invoke(
				"ghostty_terminal_get",
				this.terminal.value,
				11,
				this.scratch,
			) === OK && this.runtime.bytes(this.scratch, 1)[0] !== 0
		);
	}

	encodeMouse(input: TerminalMouseInput): string {
		this.ensureAlive();
		if (!this.mouseTracking()) return "";
		this.runtime.invoke(
			"ghostty_mouse_event_set_action",
			this.mouseEvent.value,
			input.action === "press" ? 0 : input.action === "release" ? 1 : 2,
		);
		if (input.button === null) {
			this.runtime.invoke(
				"ghostty_mouse_event_clear_button",
				this.mouseEvent.value,
			);
		} else {
			this.runtime.invoke(
				"ghostty_mouse_event_set_button",
				this.mouseEvent.value,
				input.button,
			);
		}
		this.runtime.invoke(
			"ghostty_mouse_event_set_mods",
			this.mouseEvent.value,
			input.modifiers,
		);
		this.runtime.writeField(
			this.mousePosition,
			"GhosttyMousePosition",
			"x",
			input.x,
		);
		this.runtime.writeField(
			this.mousePosition,
			"GhosttyMousePosition",
			"y",
			input.y,
		);
		this.runtime.invoke(
			"ghostty_mouse_event_set_position",
			this.mouseEvent.value,
			this.mousePosition,
		);
		this.runtime.bytes(this.scratch, 1)[0] = input.anyButtonPressed ? 1 : 0;
		this.runtime.invoke(
			"ghostty_mouse_encoder_setopt",
			this.mouseEncoder.value,
			3,
			this.scratch,
		);
		return this.encodeOutput((pointer, size, written) =>
			this.runtime.invoke(
				"ghostty_mouse_encoder_encode",
				this.mouseEncoder.value,
				this.mouseEvent.value,
				pointer,
				size,
				written,
			),
		);
	}

	setPalette(palette: TerminalPalette): void {
		this.ensureAlive();
		this.palette = palette;
		const color = this.runtime.allocate(3);
		try {
			for (const [option, value] of [
				[11, palette.foreground],
				[12, palette.background],
				[13, palette.cursor],
			] as const) {
				this.runtime.bytes(color, 3).set([value.r, value.g, value.b]);
				assertGhostty(
					"ghostty_terminal_set(color)",
					this.runtime.invoke(
						"ghostty_terminal_set",
						this.terminal.value,
						option,
						color,
					),
				);
			}
		} finally {
			this.runtime.release(color, 3);
		}
	}

	capture(): TerminalFrame {
		this.ensureAlive();
		assertGhostty(
			"ghostty_render_state_update",
			this.runtime.invoke(
				"ghostty_render_state_update",
				this.renderState.value,
				this.terminal.value,
			),
		);
		const dirty = this.renderU32(3);
		const cols = this.renderU16(1);
		const rows = this.renderU16(2);
		if (
			dirty === 0 &&
			this.frame !== null &&
			this.frame.cols === cols &&
			this.frame.rows === rows
		) {
			return this.frame;
		}
		const previous = this.frame;
		assertGhostty(
			"ghostty_render_state_get(palette)",
			this.runtime.invoke(
				"ghostty_render_state_get",
				this.renderState.value,
				9,
				this.colorPalette,
			),
		);
		const foreground = this.renderColor(6, this.palette.foreground);
		const background = this.renderColor(5, this.palette.background);
		const cursor = this.renderBool(8)
			? this.renderColor(7, this.palette.cursor)
			: this.palette.cursor;
		const cursorInViewport = this.renderBool(14);
		const lines: Array<readonly TerminalGlyph[]> = [];
		assertGhostty(
			"ghostty_render_state_get(rows)",
			this.runtime.invoke(
				"ghostty_render_state_get",
				this.renderState.value,
				4,
				this.rows.slot,
			),
		);
		while (
			lines.length < rows &&
			this.runtime.invoke(
				"ghostty_render_state_row_iterator_next",
				this.rows.value,
			) !== 0
		) {
			const index = lines.length;
			const previousLine =
				previous?.cols === cols && previous.rows === rows
					? previous.lines[index]
					: undefined;
			const rowDirty = dirty === 2 || this.rowBool(1);
			lines.push(
				!rowDirty && previousLine !== undefined
					? previousLine
					: this.readLine(cols, foreground, background),
			);
			this.runtime.bytes(this.scratch, 1)[0] = 0;
			this.runtime.invoke(
				"ghostty_render_state_row_set",
				this.rows.value,
				0,
				this.scratch,
			);
		}
		while (lines.length < rows) {
			lines.push(this.emptyLine(cols, foreground, background));
		}
		this.runtime.view(this.scratch, 4).setUint32(0, 0, true);
		this.runtime.invoke(
			"ghostty_render_state_set",
			this.renderState.value,
			0,
			this.scratch,
		);
		const frame: TerminalFrame = {
			cols,
			rows,
			lines,
			foreground,
			background,
			cursor,
			cursorX: cursorInViewport ? this.renderU16(15) : -1,
			cursorY: cursorInViewport ? this.renderU16(16) : -1,
			cursorVisible: cursorInViewport && this.renderBool(11),
			cursorBlinking: this.renderBool(12),
			cursorStyle: this.renderU32(10),
			hasBlinkingText: lines.some((line) => line.some((glyph) => glyph.blink)),
		};
		this.frame = frame;
		return frame;
	}

	encodeKey(event: KeyboardEvent, release = false): string {
		this.ensureAlive();
		this.runtime.invoke(
			"ghostty_key_encoder_setopt_from_terminal",
			this.keyEncoder.value,
			this.terminal.value,
		);
		this.runtime.invoke(
			"ghostty_key_event_set_action",
			this.keyEvent.value,
			release ? 0 : event.repeat ? 2 : 1,
		);
		this.runtime.invoke(
			"ghostty_key_event_set_key",
			this.keyEvent.value,
			ghosttyKeyCode(event.code),
		);
		this.runtime.invoke(
			"ghostty_key_event_set_mods",
			this.keyEvent.value,
			ghosttyModifiers(event),
		);
		this.runtime.invoke(
			"ghostty_key_event_set_consumed_mods",
			this.keyEvent.value,
			consumedModifiers(event),
		);
		this.runtime.invoke(
			"ghostty_key_event_set_composing",
			this.keyEvent.value,
			event.isComposing ? 1 : 0,
		);
		this.runtime.invoke(
			"ghostty_key_event_set_unshifted_codepoint",
			this.keyEvent.value,
			unshiftedCodepoint(event),
		);
		const text =
			event.key.length === 1 ? encoder.encode(event.key) : new Uint8Array();
		const textPointer =
			text.byteLength === 0 ? 0 : this.runtime.allocate(text.byteLength);
		try {
			if (textPointer !== 0)
				this.runtime.bytes(textPointer, text.byteLength).set(text);
			this.runtime.invoke(
				"ghostty_key_event_set_utf8",
				this.keyEvent.value,
				textPointer,
				text.byteLength,
			);
			return this.encodeOutput((pointer, size, written) =>
				this.runtime.invoke(
					"ghostty_key_encoder_encode",
					this.keyEncoder.value,
					this.keyEvent.value,
					pointer,
					size,
					written,
				),
			);
		} finally {
			if (textPointer !== 0) this.runtime.release(textPointer, text.byteLength);
		}
	}

	encodePaste(text: string): string {
		this.ensureAlive();
		const bytes = encoder.encode(text);
		if (bytes.byteLength === 0) return "";
		const input = this.runtime.allocate(bytes.byteLength);
		try {
			this.runtime.bytes(input, bytes.byteLength).set(bytes);
			this.runtime.bytes(this.scratch, 1)[0] = 0;
			const bracketed =
				this.runtime.invoke(
					"ghostty_terminal_mode_get",
					this.terminal.value,
					2004,
					this.scratch,
				) === OK && this.runtime.bytes(this.scratch, 1)[0] !== 0;
			return this.encodeOutput((pointer, size, written) =>
				this.runtime.invoke(
					"ghostty_paste_encode",
					input,
					bytes.byteLength,
					bracketed ? 1 : 0,
					pointer,
					size,
					written,
				),
			);
		} finally {
			this.runtime.release(input, bytes.byteLength);
		}
	}

	/** Encode DEC mode 1004 focus changes without repeating the same state. */
	encodeFocus(focused: boolean): string {
		this.ensureAlive();
		this.runtime.bytes(this.scratch, 1)[0] = 0;
		const enabled =
			this.runtime.invoke(
				"ghostty_terminal_mode_get",
				this.terminal.value,
				1004,
				this.scratch,
			) === OK && this.runtime.bytes(this.scratch, 1)[0] !== 0;
		if (!enabled) {
			this.focusReportingActive = false;
			this.reportedFocus = null;
			return "";
		}
		if (this.focusReportingActive && this.reportedFocus === focused) return "";
		const result = this.encodeOutput((pointer, size, written) =>
			this.runtime.invoke(
				"ghostty_focus_encode",
				focused ? 0 : 1,
				pointer,
				size,
				written,
			),
		);
		if (result.length > 0) {
			this.focusReportingActive = true;
			this.reportedFocus = focused;
		}
		return result;
	}

	scroll(rows: number): void {
		this.ensureAlive();
		const layout = this.runtime.layout("GhosttyTerminalScrollViewport");
		const value = this.runtime.allocate(layout.size);
		try {
			this.runtime.writeField(value, "GhosttyTerminalScrollViewport", "tag", 2);
			const payload = layout.fields.value;
			if (payload === undefined)
				throw new Error("Missing Ghostty scroll payload");
			this.runtime
				.view(value + payload.offset, payload.size)
				.setInt32(0, rows, true);
			this.runtime.invoke(
				"ghostty_terminal_scroll_viewport",
				this.terminal.value,
				value,
			);
		} finally {
			this.runtime.release(value, layout.size);
		}
	}

	selectionPress(input: TerminalSelectionInput): void {
		this.ensureAlive();
		this.clearSelection();
		const reference = this.gridReference(input.x, input.y);
		try {
			this.setGestureOption(this.selectionPressEvent, 0, reference);
			this.setGesturePosition(this.selectionPressEvent, input);
			this.runtime.view(this.scratch, 8).setFloat64(0, 5, true);
			this.setGestureOption(this.selectionPressEvent, 2, this.scratch);
			this.runtime
				.view(this.scratch, 8)
				.setBigUint64(0, this.eventTimeNs(input.timeMs), true);
			this.setGestureOption(this.selectionPressEvent, 3, this.scratch);
			this.runtime.view(this.scratch, 8).setBigUint64(0, 500_000_000n, true);
			this.setGestureOption(this.selectionPressEvent, 4, this.scratch);
			this.applyGesture(this.selectionPressEvent, true);
		} finally {
			this.runtime.release(
				reference,
				this.runtime.layout("GhosttyGridRef").size,
			);
		}
	}

	selectionDrag(input: TerminalSelectionInput): void {
		this.ensureAlive();
		const reference = this.gridReference(input.x, input.y);
		try {
			this.setGestureOption(this.selectionDragEvent, 0, reference);
			this.setGesturePosition(this.selectionDragEvent, input);
			this.runtime.bytes(this.scratch, 1)[0] = input.rectangle ? 1 : 0;
			this.setGestureOption(this.selectionDragEvent, 7, this.scratch);
			this.setGestureOption(this.selectionDragEvent, 8, this.selectionGeometry);
			this.applyGesture(this.selectionDragEvent, true);
		} finally {
			this.runtime.release(
				reference,
				this.runtime.layout("GhosttyGridRef").size,
			);
		}
	}

	/** Advance an edge drag through scrollback using Ghostty's gesture state. */
	selectionAutoscrollTick(input: TerminalSelectionInput): boolean {
		this.ensureAlive();
		this.runtime.writeField(
			this.selectionViewport,
			"GhosttyPointCoordinate",
			"x",
			input.x,
		);
		this.runtime.writeField(
			this.selectionViewport,
			"GhosttyPointCoordinate",
			"y",
			input.y,
		);
		this.setGestureOption(
			this.selectionAutoscrollEvent,
			9,
			this.selectionViewport,
		);
		this.setGesturePosition(this.selectionAutoscrollEvent, input);
		this.runtime.bytes(this.scratch, 1)[0] = input.rectangle ? 1 : 0;
		this.setGestureOption(this.selectionAutoscrollEvent, 7, this.scratch);
		this.setGestureOption(
			this.selectionAutoscrollEvent,
			8,
			this.selectionGeometry,
		);
		return this.applyGesture(this.selectionAutoscrollEvent, true);
	}

	selectionRelease(point: Readonly<{ x: number; y: number }> | null): void {
		this.ensureAlive();
		const reference = point === null ? 0 : this.gridReference(point.x, point.y);
		try {
			this.setGestureOption(this.selectionReleaseEvent, 0, reference);
			this.applyGesture(this.selectionReleaseEvent, false);
		} finally {
			if (reference !== 0) {
				this.runtime.release(
					reference,
					this.runtime.layout("GhosttyGridRef").size,
				);
			}
		}
	}

	clearSelection(): void {
		this.ensureAlive();
		this.runtime.invoke("ghostty_terminal_set", this.terminal.value, 21, 0);
	}

	selectAll(): boolean {
		this.ensureAlive();
		const layout = this.runtime.layout("GhosttySelection");
		this.runtime.bytes(this.selection, layout.size).fill(0);
		this.runtime.writeField(
			this.selection,
			"GhosttySelection",
			"size",
			layout.size,
		);
		const result = this.runtime.invoke(
			"ghostty_terminal_select_all",
			this.terminal.value,
			this.selection,
		);
		if (result === NO_VALUE) return false;
		assertGhostty("ghostty_terminal_select_all", result);
		assertGhostty(
			"ghostty_terminal_set(select all)",
			this.runtime.invoke(
				"ghostty_terminal_set",
				this.terminal.value,
				21,
				this.selection,
			),
		);
		return true;
	}

	selectionText(): string {
		this.ensureAlive();
		// This value-ABI options struct is intentionally not part of Ghostty's
		// generated type JSON. Its pinned wasm32 C layout is 16 bytes:
		// size, format enum, unwrap, trim, padding, optional selection pointer.
		const optionsSize = 16;
		const options = this.runtime.allocate(optionsSize);
		try {
			const view = this.runtime.view(options, optionsSize);
			view.setUint32(0, optionsSize, true);
			view.setInt32(4, 0, true);
			view.setUint8(8, 1);
			view.setUint8(9, 1);
			view.setUint32(12, 0, true);
			return this.encodeOutput((pointer, size, written) =>
				this.runtime.invoke(
					"ghostty_terminal_selection_format_buf",
					this.terminal.value,
					options,
					pointer,
					size,
					written,
				),
			);
		} finally {
			this.runtime.release(options, optionsSize);
		}
	}

	hyperlinkAt(x: number, y: number): string | null {
		const reference = this.gridReference(x, y);
		try {
			const value = this.encodeOutput((pointer, size, written) =>
				this.runtime.invoke(
					"ghostty_grid_ref_hyperlink_uri",
					reference,
					pointer,
					size,
					written,
				),
			);
			return value.length === 0 ? null : value;
		} finally {
			this.runtime.release(
				reference,
				this.runtime.layout("GhosttyGridRef").size,
			);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.resources.release();
	}

	private createHandle(
		create: string,
		free: string,
		thirdArgument?: number,
		freeArguments: () => ReadonlyArray<number> = () => [],
	): Handle {
		const slot = this.runtime.allocateHandleSlot();
		try {
			const arguments_ =
				thirdArgument === undefined ? [0, slot] : [0, slot, thirdArgument];
			assertGhostty(create, this.runtime.invoke(create, ...arguments_));
			const value = this.runtime.readHandle(slot);
			this.resources.add(() => this.runtime.releaseHandleSlot(slot));
			this.resources.add(() => {
				if (value !== 0) this.runtime.invoke(free, value, ...freeArguments());
			});
			return { slot, value, free };
		} catch (cause) {
			this.runtime.releaseHandleSlot(slot);
			throw cause;
		}
	}

	private acquireBuffer(size: number): number {
		const pointer = this.runtime.allocate(size);
		this.resources.add(() => this.runtime.release(pointer, size));
		return pointer;
	}

	private readLine(
		cols: number,
		foreground: Rgb,
		background: Rgb,
	): TerminalGlyph[] {
		assertGhostty(
			"ghostty_render_state_row_get(cells)",
			this.runtime.invoke(
				"ghostty_render_state_row_get",
				this.rows.value,
				3,
				this.cells.slot,
			),
		);
		const output: TerminalGlyph[] = [];
		while (
			output.length < cols &&
			this.runtime.invoke(
				"ghostty_render_state_row_cells_next",
				this.cells.value,
			) !== 0
		) {
			output.push(this.readGlyph(foreground, background));
		}
		while (output.length < cols)
			output.push(this.emptyGlyph(foreground, background));
		return output;
	}

	private readGlyph(
		defaultForeground: Rgb,
		defaultBackground: Rgb,
	): TerminalGlyph {
		const styleLayout = this.runtime.layout("GhosttyStyle");
		this.runtime.bytes(this.style, styleLayout.size).fill(0);
		this.runtime.writeField(
			this.style,
			"GhosttyStyle",
			"size",
			styleLayout.size,
		);
		this.runtime.invoke(
			"ghostty_render_state_row_cells_get",
			this.cells.value,
			2,
			this.style,
		);
		const bold =
			this.runtime.readField(this.style, "GhosttyStyle", "bold") !== 0;
		let foreground = this.cellColor(6, defaultForeground);
		let background = this.cellColor(5, defaultBackground);
		if (bold) foreground = this.boldForeground(foreground);
		if (this.runtime.readField(this.style, "GhosttyStyle", "inverse") !== 0) {
			[foreground, background] = [background, foreground];
		}
		const count = this.cellU32(3);
		let text = "";
		if (count > 0) {
			const codepoints =
				count <= CODEPOINT_SCRATCH_CAPACITY
					? this.codepoints
					: this.runtime.allocate(count * 4);
			if (
				this.runtime.invoke(
					"ghostty_render_state_row_cells_get",
					this.cells.value,
					4,
					codepoints,
				) === OK
			) {
				const view = this.runtime.view(codepoints, count * 4);
				const chunks: string[] = [];
				for (let start = 0; start < count; start += 2048) {
					const values: number[] = [];
					for (
						let index = start;
						index < Math.min(count, start + 2048);
						index += 1
					) {
						values.push(view.getUint32(index * 4, true));
					}
					chunks.push(String.fromCodePoint(...values));
				}
				text = chunks.join("");
			}
			if (codepoints !== this.codepoints) {
				this.runtime.release(codepoints, count * 4);
			}
		}
		if (this.runtime.readField(this.style, "GhosttyStyle", "invisible") !== 0) {
			text = "";
		}
		return {
			text,
			foreground,
			background,
			bold,
			italic:
				this.runtime.readField(this.style, "GhosttyStyle", "italic") !== 0,
			faint: this.runtime.readField(this.style, "GhosttyStyle", "faint") !== 0,
			blink: this.runtime.readField(this.style, "GhosttyStyle", "blink") !== 0,
			underlineStyle: this.runtime.readField(
				this.style,
				"GhosttyStyle",
				"underline",
			),
			underlineColor: this.styleColor("underline_color", foreground),
			strikethrough:
				this.runtime.readField(this.style, "GhosttyStyle", "strikethrough") !==
				0,
			overline:
				this.runtime.readField(this.style, "GhosttyStyle", "overline") !== 0,
			selected: this.cellBool(7),
		};
	}

	private renderU16(kind: number): number {
		this.runtime.view(this.scratch, 2).setUint16(0, 0, true);
		assertGhostty(
			"ghostty_render_state_get(u16)",
			this.runtime.invoke(
				"ghostty_render_state_get",
				this.renderState.value,
				kind,
				this.scratch,
			),
		);
		return this.runtime.view(this.scratch, 2).getUint16(0, true);
	}

	private renderU32(kind: number): number {
		this.runtime.view(this.scratch, 4).setUint32(0, 0, true);
		assertGhostty(
			"ghostty_render_state_get(u32)",
			this.runtime.invoke(
				"ghostty_render_state_get",
				this.renderState.value,
				kind,
				this.scratch,
			),
		);
		return this.runtime.view(this.scratch, 4).getUint32(0, true);
	}

	private renderBool(kind: number): boolean {
		this.runtime.bytes(this.scratch, 1)[0] = 0;
		assertGhostty(
			"ghostty_render_state_get(bool)",
			this.runtime.invoke(
				"ghostty_render_state_get",
				this.renderState.value,
				kind,
				this.scratch,
			),
		);
		return this.runtime.bytes(this.scratch, 1)[0] !== 0;
	}

	private renderColor(kind: number, fallback: Rgb): Rgb {
		this.runtime.bytes(this.scratch, 3).fill(0);
		const result = this.runtime.invoke(
			"ghostty_render_state_get",
			this.renderState.value,
			kind,
			this.scratch,
		);
		return result === OK ? rgb(this.runtime.bytes(this.scratch, 3)) : fallback;
	}

	private rowBool(kind: number): boolean {
		this.runtime.bytes(this.scratch, 1)[0] = 0;
		return (
			this.runtime.invoke(
				"ghostty_render_state_row_get",
				this.rows.value,
				kind,
				this.scratch,
			) === OK && this.runtime.bytes(this.scratch, 1)[0] !== 0
		);
	}

	private paletteColor(index: number): Rgb {
		return rgb(this.runtime.bytes(this.colorPalette + index * 3, 3));
	}

	private styleColor(fieldName: string, fallback: Rgb): Rgb {
		const field = this.runtime.layout("GhosttyStyle").fields[fieldName];
		if (field === undefined) return fallback;
		const view = this.runtime.view(this.style + field.offset, field.size);
		const tag = view.getUint32(0, true);
		if (tag === 1) return this.paletteColor(view.getUint8(8));
		if (tag === 2) {
			return rgb(this.runtime.bytes(this.style + field.offset + 8, 3));
		}
		return fallback;
	}

	private boldForeground(fallback: Rgb): Rgb {
		const field = this.runtime.layout("GhosttyStyle").fields.fg_color;
		if (field === undefined) return fallback;
		const view = this.runtime.view(this.style + field.offset, field.size);
		const paletteIndex = view.getUint8(8);
		return view.getUint32(0, true) === 1 && paletteIndex < 8
			? this.paletteColor(paletteIndex + 8)
			: fallback;
	}

	private cellU32(kind: number): number {
		this.runtime.view(this.scratch, 4).setUint32(0, 0, true);
		assertGhostty(
			"ghostty_render_state_row_cells_get(u32)",
			this.runtime.invoke(
				"ghostty_render_state_row_cells_get",
				this.cells.value,
				kind,
				this.scratch,
			),
		);
		return this.runtime.view(this.scratch, 4).getUint32(0, true);
	}

	private cellBool(kind: number): boolean {
		this.runtime.bytes(this.scratch, 1)[0] = 0;
		return (
			this.runtime.invoke(
				"ghostty_render_state_row_cells_get",
				this.cells.value,
				kind,
				this.scratch,
			) === OK && this.runtime.bytes(this.scratch, 1)[0] !== 0
		);
	}

	private cellColor(kind: number, fallback: Rgb): Rgb {
		this.runtime.bytes(this.scratch, 3).fill(0);
		const result = this.runtime.invoke(
			"ghostty_render_state_row_cells_get",
			this.cells.value,
			kind,
			this.scratch,
		);
		return result === OK ? rgb(this.runtime.bytes(this.scratch, 3)) : fallback;
	}

	private setGestureOption(
		event: Handle,
		option: number,
		pointer: number,
	): void {
		assertGhostty(
			"ghostty_selection_gesture_event_set",
			this.runtime.invoke(
				"ghostty_selection_gesture_event_set",
				event.value,
				option,
				pointer,
			),
		);
	}

	private setGesturePosition(
		event: Handle,
		input: TerminalSelectionInput,
	): void {
		this.runtime.writeField(
			this.selectionPosition,
			"GhosttySurfacePosition",
			"x",
			input.surfaceX,
		);
		this.runtime.writeField(
			this.selectionPosition,
			"GhosttySurfacePosition",
			"y",
			input.surfaceY,
		);
		this.setGestureOption(event, 1, this.selectionPosition);
	}

	private applyGesture(event: Handle, installSelection: boolean): boolean {
		const layout = this.runtime.layout("GhosttySelection");
		this.runtime.bytes(this.selection, layout.size).fill(0);
		this.runtime.writeField(
			this.selection,
			"GhosttySelection",
			"size",
			layout.size,
		);
		const result = this.runtime.invoke(
			"ghostty_selection_gesture_event",
			this.selectionGesture.value,
			this.terminal.value,
			event.value,
			installSelection ? this.selection : 0,
		);
		if (result === NO_VALUE) return false;
		assertGhostty("ghostty_selection_gesture_event", result);
		if (installSelection) {
			assertGhostty(
				"ghostty_terminal_set(selection gesture)",
				this.runtime.invoke(
					"ghostty_terminal_set",
					this.terminal.value,
					21,
					this.selection,
				),
			);
		}
		return true;
	}

	private eventTimeNs(timeMs: number): bigint {
		const microseconds = Number.isFinite(timeMs)
			? Math.max(0, Math.round(timeMs * 1_000))
			: 0;
		return BigInt(microseconds) * 1_000n;
	}

	private gridReference(x: number, y: number): number {
		const pointLayout = this.runtime.layout("GhosttyPoint");
		const point = this.runtime.allocate(pointLayout.size);
		const referenceLayout = this.runtime.layout("GhosttyGridRef");
		const reference = this.runtime.allocate(referenceLayout.size);
		let succeeded = false;
		try {
			this.runtime.writeField(point, "GhosttyPoint", "tag", 1);
			const value = pointLayout.fields.value;
			if (value === undefined) throw new Error("Missing Ghostty point layout");
			const view = this.runtime.view(point + value.offset, value.size);
			view.setUint16(0, Math.max(0, x), true);
			view.setUint16(2, Math.max(0, y), true);
			this.runtime.writeField(
				reference,
				"GhosttyGridRef",
				"size",
				referenceLayout.size,
			);
			assertGhostty(
				"ghostty_terminal_grid_ref",
				this.runtime.invoke(
					"ghostty_terminal_grid_ref",
					this.terminal.value,
					point,
					reference,
				),
			);
			succeeded = true;
			return reference;
		} finally {
			this.runtime.release(point, pointLayout.size);
			if (!succeeded) this.runtime.release(reference, referenceLayout.size);
		}
	}

	private encodeOutput(
		operation: (pointer: number, size: number, written: number) => number,
	): string {
		const written = this.runtime.invoke("ghostty_wasm_alloc_usize");
		try {
			const first = operation(0, 0, written);
			const size = this.runtime.view(written, 4).getUint32(0, true);
			if (first === OK && size === 0) return "";
			if (first !== OUT_OF_SPACE || size === 0) return "";
			const pointer = this.runtime.allocate(size);
			try {
				const result = operation(pointer, size, written);
				const length = this.runtime.view(written, 4).getUint32(0, true);
				return result === OK
					? decoder.decode(this.runtime.bytes(pointer, length))
					: "";
			} finally {
				this.runtime.release(pointer, size);
			}
		} finally {
			this.runtime.invoke("ghostty_wasm_free_usize", written);
		}
	}

	private emptyLine(
		cols: number,
		foreground: Rgb,
		background: Rgb,
	): TerminalGlyph[] {
		return Array.from({ length: cols }, () =>
			this.emptyGlyph(foreground, background),
		);
	}

	private emptyGlyph(foreground: Rgb, background: Rgb): TerminalGlyph {
		return {
			text: "",
			foreground,
			background,
			bold: false,
			italic: false,
			faint: false,
			blink: false,
			underlineStyle: 0,
			underlineColor: foreground,
			strikethrough: false,
			overline: false,
			selected: false,
		};
	}

	private ensureAlive(): void {
		if (this.disposed) throw new Error("Ghostty terminal has been disposed");
	}
}
