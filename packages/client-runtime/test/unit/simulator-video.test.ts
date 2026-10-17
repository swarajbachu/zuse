import { afterEach, expect, it, vi } from "vitest";
import {
	androidKeycode,
	annexBSps,
	SimulatorVideo,
	simulatorKeyUsage,
} from "../../src/simulators/video.ts";

afterEach(() => vi.unstubAllGlobals());
const packet = (tag: number, data: number[]) => ({
	tag,
	data: btoa(String.fromCharCode(...data)),
});
function fixture() {
	const drawImage = vi.fn(),
		fallback = vi.fn();
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => ({
			drawImage,
			save: vi.fn(),
			restore: vi.fn(),
			translate: vi.fn(),
			rotate: vi.fn(),
		}),
	} as unknown as HTMLCanvasElement;
	const decoders: FakeDecoder[] = [];
	class FakeDecoder {
		static isConfigSupported = async () => ({ supported: true });
		state = "unconfigured";
		decodeQueueSize = 0;
		configure = vi.fn(() => {
			this.state = "configured";
		});
		reset = vi.fn(() => {
			this.state = "unconfigured";
			this.decodeQueueSize = 0;
		});
		decode = vi.fn();
		close = vi.fn(() => {
			this.state = "closed";
		});
		constructor(
			readonly callbacks: {
				output: (frame: VideoFrame) => void;
				error: () => void;
			},
		) {
			decoders.push(this);
		}
	}
	vi.stubGlobal("VideoDecoder", FakeDecoder);
	vi.stubGlobal(
		"EncodedVideoChunk",
		class {
			constructor(readonly options: unknown) {}
		},
	);
	return {
		video: new SimulatorVideo(canvas, fallback),
		drawImage,
		decoders,
		fallback,
		canvas,
	};
}
it("drops delta frames until a keyframe and resets overloaded decoders", async () => {
	const { video, decoders } = fixture();
	await video.packet(packet(1, [1, 100, 0, 31]));
	const decoder = decoders[0];
	if (!decoder) throw Error("Missing decoder");
	await video.packet(packet(3, [9]));
	expect(decoder.decode).not.toHaveBeenCalled();
	await video.packet(packet(2, [8]));
	expect(decoder.decode).toHaveBeenCalledTimes(1);
	decoder.decodeQueueSize = 10;
	await video.packet(packet(3, [9]));
	expect(decoder.reset).toHaveBeenCalledTimes(1);
	expect(decoder.decode).toHaveBeenCalledTimes(1);
	await video.packet(packet(2, [8]));
	expect(decoder.decode).toHaveBeenCalledTimes(2);
	video.close();
	expect(decoder.close).toHaveBeenCalledTimes(1);
});
it("releases decoded frames even after disposal", async () => {
	const { video, decoders, drawImage } = fixture();
	await video.packet(packet(1, [1, 100, 0, 31]));
	const frame = {
		displayWidth: 120,
		displayHeight: 240,
		close: vi.fn(),
	} as unknown as VideoFrame;
	video.close();
	decoders[0]?.callbacks.output(frame);
	expect(frame.close).toHaveBeenCalledTimes(1);
	expect(drawImage).not.toHaveBeenCalled();
});
it("releases JPEG bitmaps when disposed during decode", async () => {
	const { video, drawImage } = fixture();
	let resolve: (value: ImageBitmap) => void = () => {};
	vi.stubGlobal(
		"createImageBitmap",
		() =>
			new Promise<ImageBitmap>((done) => {
				resolve = done;
			}),
	);
	const bitmap = {
		width: 120,
		height: 240,
		close: vi.fn(),
	} as unknown as ImageBitmap;
	const job = video.packet(packet(4, [255, 216, 255, 217]));
	video.close();
	resolve(bitmap);
	await job;
	expect(bitmap.close).toHaveBeenCalledTimes(1);
	expect(drawImage).not.toHaveBeenCalled();
});
it("requests JPEG fallback once for unsupported codecs", async () => {
	const { video, fallback } = fixture();
	vi.stubGlobal("VideoDecoder", undefined);
	await video.packet(packet(1, [1, 100, 0, 31]));
	await video.packet(packet(1, [1, 100, 0, 31]));
	expect(fallback).toHaveBeenCalledTimes(1);
	video.close();
});
it("maps modifier and letter keys to HID usages", () => {
	expect(simulatorKeyUsage("KeyA")).toBe(4);
	expect(simulatorKeyUsage("ShiftRight")).toBe(229);
	expect(simulatorKeyUsage("Unrecognized")).toBeNull();
});

it("rotates a portrait framebuffer and maps touches back into its raw coordinates", async () => {
	const { video, decoders, canvas } = fixture();
	await video.packet({
		tag: 130,
		data: btoa(JSON.stringify({ orientation: "landscape_left" })),
	});
	await video.packet(packet(1, [1, 100, 0, 31]));
	const frame = {
		displayWidth: 120,
		displayHeight: 240,
		close: vi.fn(),
	} as unknown as VideoFrame;
	decoders[0]?.callbacks.output(frame);
	expect(canvas.width).toBe(240);
	expect(canvas.height).toBe(120);
	expect(video.point(0.25, 0.5)).toEqual({ x: 0.5, y: 0.75 });
	expect(frame.close).toHaveBeenCalledTimes(1);
	video.close();
});
it("configures Android streams from the keyframe's SPS and rebuilds after encoder restarts", async () => {
	const { video, decoders } = fixture();
	const sps = [0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f];
	const idr = [0, 0, 0, 1, 0x65, 1];
	await video.packet(packet(17, [0, 0, 0, 1, 0x41]));
	expect(decoders).toHaveLength(0);
	await video.packet(packet(16, [...sps, ...idr]));
	const decoder = decoders[0];
	if (!decoder) throw Error("Missing decoder");
	expect(decoder.configure).toHaveBeenCalledWith({
		codec: "avc1.42c01f",
		optimizeForLatency: true,
	});
	expect(decoder.decode).toHaveBeenCalledTimes(1);
	await video.packet(packet(17, [0, 0, 0, 1, 0x41]));
	expect(decoder.decode).toHaveBeenCalledTimes(2);
	await video.packet(packet(18, []));
	expect(decoder.reset).toHaveBeenCalledTimes(1);
	await video.packet(packet(17, [0, 0, 0, 1, 0x41]));
	expect(decoder.decode).toHaveBeenCalledTimes(2);
	await video.packet(packet(16, [...sps, ...idr]));
	expect(decoder.configure).toHaveBeenCalledTimes(2);
	expect(decoder.decode).toHaveBeenCalledTimes(3);
});
it("maps keys without text to Android keycodes", () => {
	expect(androidKeycode("Backspace")).toBe(67);
	expect(androidKeycode("ArrowUp")).toBe(19);
	expect(androidKeycode("a")).toBeNull();
	expect(annexBSps(new Uint8Array([0, 0, 1, 0x65]))).toBeNull();
});
