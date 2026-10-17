import type { SimulatorPacket } from "@zuse/contracts";
/** A view owns its decoder. Closing or hiding the view releases every native frame. */
export class SimulatorVideo {
	private decoder: VideoDecoder | undefined;
	private config: VideoDecoderConfig | undefined;
	private disposed = false;
	private waitingForKeyframe = true;
	private timestamp = 0;
	private orientation = "portrait";
	private rawWidth = 0;
	private rawHeight = 0;
	private fallbackRequested = false;
	/** Android streams configure from the SPS inside a keyframe instead of an avcC record. */
	private annexB = false;
	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly fallback: () => void,
		/** Called only when the painted size changes, including the first frame. */
		private readonly onSize?: (width: number, height: number) => void,
	) {}
	static supported() {
		return (
			typeof VideoDecoder !== "undefined" &&
			typeof EncodedVideoChunk !== "undefined"
		);
	}
	async packet(packet: SimulatorPacket) {
		if (this.disposed) return;
		const data = Uint8Array.from(atob(packet.data), (char) =>
			char.charCodeAt(0),
		);
		if (packet.tag === 18) {
			// The Android encoder restarted, e.g. after rotation: rebuild from its next keyframe.
			this.resetDecoder();
			return;
		}
		if (packet.tag === 16 || packet.tag === 17) {
			await this.annexBPacket(data, packet.tag === 16);
			return;
		}
		if (packet.tag === 130) {
			const config: { orientation?: string } = JSON.parse(
				new TextDecoder().decode(data),
			);
			this.orientation = config.orientation ?? "portrait";
			return;
		}
		if (packet.tag === 4) {
			const bitmap = await createImageBitmap(
				new Blob([data], { type: "image/jpeg" }),
			);
			try {
				if (!this.disposed) this.paint(bitmap, bitmap.width, bitmap.height);
			} finally {
				bitmap.close();
			}
			return;
		}
		if (packet.tag === 1) {
			this.waitingForKeyframe = true;
			if (!SimulatorVideo.supported() || data.length < 4) {
				this.useFallback();
				return;
			}
			const config: VideoDecoderConfig = {
				codec: avcCodec(data),
				description: data,
				optimizeForLatency: true,
			};
			const supported = await VideoDecoder.isConfigSupported(config).catch(
				() => ({ supported: false }),
			);
			if (this.disposed) return;
			if (!supported.supported) {
				this.useFallback();
				return;
			}
			this.annexB = false;
			this.config = config;
			this.ensureDecoder().configure(config);
			return;
		}
		if (packet.tag !== 2 && packet.tag !== 3) return;
		this.decode(data, packet.tag === 2);
	}
	private async annexBPacket(data: Uint8Array, key: boolean) {
		if (!SimulatorVideo.supported()) {
			this.useFallback();
			return;
		}
		if (!this.annexB || this.decoder?.state !== "configured") {
			if (!key) return;
			const sps = annexBSps(data);
			if (!sps) return;
			const config: VideoDecoderConfig = {
				codec: avcCodec(sps),
				optimizeForLatency: true,
			};
			const supported = await VideoDecoder.isConfigSupported(config).catch(
				() => ({ supported: false }),
			);
			if (this.disposed) return;
			if (!supported.supported) {
				this.useFallback();
				return;
			}
			this.annexB = true;
			this.config = config;
			this.waitingForKeyframe = true;
			this.ensureDecoder().configure(config);
		}
		this.decode(data, key);
	}
	private ensureDecoder() {
		// A decoder that reported an error is closed and cannot be reconfigured.
		if (this.decoder?.state === "closed") this.decoder = undefined;
		this.decoder ??= new VideoDecoder({
			output: (frame) => {
				try {
					if (!this.disposed)
						this.paint(frame, frame.displayWidth, frame.displayHeight);
				} finally {
					frame.close();
				}
			},
			error: () => {
				if (!this.disposed) this.useFallback();
			},
		});
		return this.decoder;
	}
	private resetDecoder() {
		if (this.decoder?.state === "configured") this.decoder.reset();
		this.annexB = false;
		this.waitingForKeyframe = true;
	}
	/** Decodes in order, dropping a backlog and resuming at the next keyframe. */
	private decode(data: Uint8Array, key: boolean) {
		if (this.decoder?.state !== "configured") return;
		if (this.decoder.decodeQueueSize > 8 && this.config) {
			this.decoder.reset();
			this.decoder.configure(this.config);
			this.waitingForKeyframe = true;
		}
		if (this.waitingForKeyframe && !key) return;
		this.waitingForKeyframe = false;
		this.timestamp += 16667;
		this.decoder.decode(
			new EncodedVideoChunk({
				type: key ? "key" : "delta",
				timestamp: this.timestamp,
				data,
			}),
		);
	}
	private paint(image: CanvasImageSource, width: number, height: number) {
		// Frames are flowing again, so a later failure is reported afresh.
		this.fallbackRequested = false;
		this.rawWidth = width;
		this.rawHeight = height;
		const rotation = width <= height ? this.orientation : "portrait";
		const landscape =
			rotation === "landscape_left" || rotation === "landscape_right";
		const displayWidth = landscape ? height : width,
			displayHeight = landscape ? width : height;
		if (
			this.canvas.width !== displayWidth ||
			this.canvas.height !== displayHeight
		) {
			this.canvas.width = displayWidth;
			this.canvas.height = displayHeight;
			this.onSize?.(displayWidth, displayHeight);
		}
		const context = this.canvas.getContext("2d", { alpha: false });
		if (!context) return;
		context.save();
		try {
			if (rotation === "landscape_left") {
				context.translate(height, 0);
				context.rotate(Math.PI / 2);
			} else if (rotation === "landscape_right") {
				context.translate(0, width);
				context.rotate(-Math.PI / 2);
			} else if (rotation === "portrait_upside_down") {
				context.translate(width, height);
				context.rotate(Math.PI);
			}
			context.drawImage(image, 0, 0, width, height);
		} finally {
			context.restore();
		}
	}

	private useFallback() {
		if (!this.fallbackRequested && !this.disposed) {
			this.fallbackRequested = true;
			this.fallback();
		}
	}
	point(x: number, y: number) {
		if (this.rawWidth > this.rawHeight) return { x, y };
		if (this.orientation === "landscape_left") return { x: y, y: 1 - x };
		if (this.orientation === "landscape_right") return { x: 1 - y, y: x };
		if (this.orientation === "portrait_upside_down")
			return { x: 1 - x, y: 1 - y };
		return { x, y };
	}
	close() {
		this.disposed = true;
		this.decoder?.close();
		this.decoder = undefined;
	}
}

/** USB HID usages used by the simulator input helper, rather than text keycodes. */
export function simulatorKeyUsage(code: string): number | null {
	if (/^Key[A-Z]$/u.test(code)) return code.charCodeAt(3) - 65 + 4;
	if (/^Digit[1-9]$/u.test(code)) return Number(code[5]) + 29;
	const keys: Record<string, number> = {
		Digit0: 39,
		Enter: 40,
		Escape: 41,
		Backspace: 42,
		Tab: 43,
		Space: 44,
		Minus: 45,
		Equal: 46,
		BracketLeft: 47,
		BracketRight: 48,
		Backslash: 49,
		Semicolon: 51,
		Quote: 52,
		Backquote: 53,
		Comma: 54,
		Period: 55,
		Slash: 56,
		Delete: 76,
		Home: 74,
		End: 77,
		PageUp: 75,
		PageDown: 78,
		ArrowRight: 79,
		ArrowLeft: 80,
		ArrowDown: 81,
		ArrowUp: 82,
		ControlLeft: 224,
		ShiftLeft: 225,
		AltLeft: 226,
		MetaLeft: 227,
		ControlRight: 228,
		ShiftRight: 229,
		AltRight: 230,
		MetaRight: 231,
	};
	return keys[code] ?? null;
}

/** WebCodecs `avc1.PPCCLL` from an avcC record or an SPS NAL; both carry profile bytes at 1–3. */
export function avcCodec(bytes: Uint8Array): string {
	return `avc1.${[bytes[1], bytes[2], bytes[3]].map((byte) => (byte ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

/** The first SPS NAL (type 7) in an Annex-B access unit, without its start code. */
export function annexBSps(data: Uint8Array): Uint8Array | null {
	for (let i = 0; i + 3 < data.length; i++) {
		if (data[i] !== 0 || data[i + 1] !== 0) continue;
		const start =
			data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
		if (!start) continue;
		if (((data[i + start] ?? 0) & 0x1f) === 7) {
			const sps = data.subarray(i + start);
			return sps.length >= 4 ? sps : null;
		}
		i += start;
	}
	return null;
}

/**
 * Android keycodes for keys that have no text. Printable keys are sent as
 * text; Escape acts as Back.
 */
export function androidKeycode(key: string): number | null {
	const keys: Record<string, number> = {
		ArrowUp: 19,
		ArrowDown: 20,
		ArrowLeft: 21,
		ArrowRight: 22,
		Tab: 61,
		Enter: 66,
		Backspace: 67,
		Delete: 112,
		Home: 122,
		End: 123,
		PageUp: 92,
		PageDown: 93,
	};
	return keys[key] ?? null;
}
