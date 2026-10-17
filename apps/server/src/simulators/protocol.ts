import type { SimulatorInput, SimulatorPacket } from "@zuse/contracts";

const LIMIT = 8 * 1024 * 1024;
/** Bound buffered native data even when packet boundaries span transport chunks. */
export class SimulatorPacketParser {
	private buffer = Buffer.alloc(0);
	constructor(private readonly format: "avcc" | "mjpeg") {}
	push(chunk: Uint8Array): SimulatorPacket[] {
		if (this.buffer.length + chunk.length > LIMIT)
			throw new Error("Simulator stream packet exceeded its limit");
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const packets: SimulatorPacket[] = [];
		if (this.format === "avcc") {
			while (this.buffer.length >= 4) {
				const size = this.buffer.readUInt32BE(0);
				if (size < 1 || size > LIMIT / 2)
					throw new Error("Invalid simulator video packet");
				if (this.buffer.length < size + 4) break;
				packets.push({
					tag: this.buffer[4] ?? 0,
					data: this.buffer.subarray(5, size + 4).toString("base64"),
				});
				this.buffer = this.buffer.subarray(size + 4);
			}
		} else {
			while (true) {
				const start = this.buffer.indexOf(Buffer.from([255, 216]));
				if (start < 0) {
					this.buffer = this.buffer.subarray(
						Math.max(0, this.buffer.length - 1),
					);
					break;
				}
				const end = this.buffer.indexOf(Buffer.from([255, 217]), start + 2);
				if (end < 0) {
					this.buffer = this.buffer.subarray(start);
					break;
				}
				packets.push({
					tag: 4,
					data: this.buffer.subarray(start, end + 2).toString("base64"),
				});
				this.buffer = this.buffer.subarray(end + 2);
			}
		}
		return packets;
	}
}
export async function readBounded(
	response: Response,
	limit: number,
): Promise<Buffer> {
	if (!response.body) throw new Error("Device response has no body");
	const reader = response.body.getReader(),
		chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.length;
			if (length > limit) throw new Error("Device response exceeded its limit");
			chunks.push(chunk.value);
		}
		return Buffer.concat(chunks);
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

const SEMU_MAGIC = 0x53454d55;
const SEMU_HEADER_BYTES: Record<number, number> = { 1: 16, 2: 24 };
export const ANDROID_KEY_PACKET = 16;
export const ANDROID_DELTA_PACKET = 17;
export const ANDROID_RESET_PACKET = 18;

/** True when an Annex-B access unit contains an IDR slice. */
export function annexBKeyframe(data: Uint8Array): boolean {
	for (let i = 0; i + 3 < data.length; i++) {
		if (data[i] !== 0 || data[i + 1] !== 0) continue;
		const start =
			data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
		if (!start) continue;
		if (((data[i + start] ?? 0) & 0x1f) === 5) return true;
		i += start;
	}
	return false;
}

/**
 * Converts one serve-emu WebSocket message. Binary messages carry an H.264
 * access unit behind a "SEMU" v1 (16-byte) or v2 (24-byte) header; text
 * `video-session` messages mean the encoder restarted, e.g. after rotation.
 */
export function androidVideoPacket(
	message: Buffer | string,
): SimulatorPacket | null {
	if (typeof message === "string") {
		try {
			const parsed: unknown = JSON.parse(message);
			return typeof parsed === "object" &&
				parsed !== null &&
				"type" in parsed &&
				parsed.type === "video-session"
				? { tag: ANDROID_RESET_PACKET, data: "" }
				: null;
		} catch {
			return null;
		}
	}
	if (message.length > LIMIT)
		throw new Error("Emulator video packet exceeded its limit");
	let data: Uint8Array = message;
	let key: boolean | null = null;
	const header =
		message.length > 16 && message.readUInt32BE(0) === SEMU_MAGIC
			? SEMU_HEADER_BYTES[message[4] ?? 0]
			: undefined;
	if (header !== undefined && message.length > header) {
		key = ((message[5] ?? 0) & 1) === 1;
		data = message.subarray(header);
	}
	if (data.length === 0) return null;
	return {
		tag:
			(key ?? annexBKeyframe(data)) ? ANDROID_KEY_PACKET : ANDROID_DELTA_PACKET,
		data: Buffer.from(data.buffer, data.byteOffset, data.length).toString(
			"base64",
		),
	};
}

/** serve-emu gesture JSON for one viewer input, or null when Android has no equivalent. */
export function androidGesture(input: SimulatorInput): object | null {
	switch (input._tag) {
		case "touch":
			return {
				type: "touch",
				action:
					input.phase === "begin"
						? "down"
						: input.phase === "move"
							? "move"
							: "up",
				x: input.x,
				y: input.y,
			};
		case "text":
			return { type: "text", text: input.text };
		case "keycode":
			return { type: "key", keycode: input.keycode };
		case "button":
			return {
				type:
					input.button === "app_switcher"
						? "recents"
						: input.button === "lock"
							? "power"
							: input.button,
			};
		default:
			return null;
	}
}
