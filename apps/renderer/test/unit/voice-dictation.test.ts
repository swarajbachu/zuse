import type { AgentAvailability } from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canDictate, VoiceDictation } from "../../src/lib/voice-dictation";

class Recorder {
	static isTypeSupported = () => true;
	static instances: Recorder[] = [];
	state = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor() {
		Recorder.instances.push(this);
	}
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		queueMicrotask(() => {
			this.ondataavailable?.({ data: new Blob(["audio"]) });
			this.onstop?.();
		});
	}
}
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe("voice dictation lifecycle", () => {
	const track = { stop: vi.fn(), onended: null as (() => void) | null };
	const stream = { getTracks: () => [track] };
	const getUserMedia = vi.fn();
	const create = () => {
		const callbacks = {
			capabilities: vi.fn(async () => ({
				available: true,
				maxDurationSeconds: 150,
				maxBytes: 1024,
			})),
			transcribe: vi.fn(
				async (_audio: {
					bytes: Uint8Array;
					mimeType: string;
					durationMs: number;
				}) => "spoken words",
			),
			onState: vi.fn(),
			onTranscript: vi.fn(),
			onError: vi.fn(),
		};
		return { controller: new VoiceDictation(callbacks), ...callbacks };
	};
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		Recorder.instances = [];
		track.onended = null;
		getUserMedia.mockResolvedValue(stream);
		vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
		vi.stubGlobal("MediaRecorder", Recorder);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	it("releases the microphone before transcription and delivers text once", async () => {
		const voice = create();
		await voice.controller.start();
		voice.controller.stop();
		voice.controller.stop();
		expect(track.stop).toHaveBeenCalled();
		await flush();
		expect(voice.transcribe).toHaveBeenCalledTimes(1);
		expect(voice.transcribe.mock.calls[0]?.[0]).toMatchObject({
			mimeType: "audio/webm",
		});
		expect(voice.onTranscript).toHaveBeenCalledExactlyOnceWith("spoken words");
		voice.controller.cancel();
	});
	it("releases a stream granted after cancellation without recording", async () => {
		const permission = deferred<typeof stream>();
		getUserMedia.mockReturnValue(permission.promise);
		const voice = create();
		const start = voice.controller.start();
		await flush();
		voice.controller.cancel();
		permission.resolve(stream);
		await start;
		expect(track.stop).toHaveBeenCalled();
		expect(Recorder.instances).toHaveLength(0);
	});
	it("ignores a transcription delivered after cancel or session teardown", async () => {
		const response = deferred<string>();
		const voice = create();
		voice.transcribe.mockReturnValue(response.promise);
		await voice.controller.start();
		voice.controller.stop();
		await flush();
		voice.controller.cancel();
		response.resolve("stale transcript");
		await flush();
		expect(voice.onTranscript).not.toHaveBeenCalled();
	});
	it("stops at the server duration limit", async () => {
		const voice = create();
		await voice.controller.start();
		await vi.advanceTimersByTimeAsync(150_000);
		expect(voice.transcribe).toHaveBeenCalledTimes(1);
		expect(track.stop).toHaveBeenCalled();
	});
	it("cancels oversized recordings without sending audio", async () => {
		const voice = create();
		await voice.controller.start();
		Recorder.instances[0]?.ondataavailable?.({
			data: new Blob([new Uint8Array(1025)]),
		});
		await flush();
		expect(voice.onError).toHaveBeenCalledWith("too_large");
		expect(voice.transcribe).not.toHaveBeenCalled();
		expect(track.stop).toHaveBeenCalled();
	});
	it("does not request the microphone without a compatible account", async () => {
		const voice = create();
		voice.capabilities.mockResolvedValue({
			available: false,
			maxDurationSeconds: 150,
			maxBytes: 1024,
		});
		await voice.controller.start();
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(voice.onError).toHaveBeenCalledWith("account_required");
	});
	it("handles denied permission and allows retry", async () => {
		const voice = create();
		getUserMedia.mockRejectedValueOnce(
			new DOMException("Denied", "NotAllowedError"),
		);
		await voice.controller.start();
		expect(voice.onError).toHaveBeenCalledWith("permission_denied");
		await voice.controller.start();
		expect(Recorder.instances).toHaveLength(1);
		voice.controller.cancel();
	});
	it("reports a missing microphone distinctly from denied access", async () => {
		const voice = create();
		getUserMedia.mockRejectedValueOnce(
			new DOMException("No device", "NotFoundError"),
		);
		await voice.controller.start();
		expect(voice.onError).toHaveBeenCalledWith("no_microphone");
	});
	it("meters elapsed and remaining time only while recording", async () => {
		const voice = create();
		expect(voice.controller.meter()).toBeNull();
		await voice.controller.start();
		await vi.advanceTimersByTimeAsync(4_000);
		const meter = voice.controller.meter();
		expect(meter?.elapsedMs).toBeGreaterThanOrEqual(4_000);
		expect(meter?.remainingMs).toBeLessThanOrEqual(146_000);
		expect(meter?.level).toBe(0);
		voice.controller.stop();
		expect(voice.controller.meter()).toBeNull();
		voice.controller.cancel();
	});
	it("reports recorder failure and releases hardware", async () => {
		const voice = create();
		await voice.controller.start();
		Recorder.instances[0]?.onerror?.();
		expect(track.stop).toHaveBeenCalled();
		expect(voice.onError).toHaveBeenCalledWith("recorder_failed");
		expect(voice.transcribe).not.toHaveBeenCalled();
	});
	it("reports empty transcripts and permits another recording", async () => {
		const voice = create();
		voice.transcribe.mockResolvedValueOnce("   ");
		await voice.controller.start();
		voice.controller.stop();
		await flush();
		expect(voice.onTranscript).not.toHaveBeenCalled();
		expect(voice.onError).toHaveBeenCalledWith("no_speech");
		await voice.controller.start();
		voice.controller.stop();
		await flush();
		expect(voice.onTranscript).toHaveBeenCalledExactlyOnceWith("spoken words");
	});
	it("ignores failure from cancelled transcription during a new recording", async () => {
		let reject!: (error: Error) => void;
		const response = new Promise<string>((_, fail) => {
			reject = fail;
		});
		const voice = create();
		voice.transcribe.mockReturnValueOnce(response);
		await voice.controller.start();
		voice.controller.stop();
		await flush();
		voice.controller.cancel();
		await voice.controller.start();
		reject(new Error("Old request failed"));
		await flush();
		expect(voice.onError).not.toHaveBeenCalled();
		expect(voice.onState).toHaveBeenLastCalledWith("recording");
		voice.controller.cancel();
	});
});

describe("phrase-by-phrase dictation", () => {
	const track = { stop: vi.fn(), onended: null as (() => void) | null };
	const stream = { getTracks: () => [track] };
	/** Microphone amplitude as a meter level, 0 (silence) to 1. */
	let loudness = 0;
	class AudioContextStub {
		createAnalyser() {
			return {
				fftSize: 512,
				getByteTimeDomainData: (samples: Uint8Array) =>
					samples.fill(128 + Math.round((loudness / 4) * 128)),
			};
		}
		createMediaStreamSource() {
			return { connect: () => undefined };
		}
		close() {
			return Promise.resolve();
		}
	}
	const create = () => {
		const callbacks = {
			capabilities: vi.fn(async () => ({
				available: true,
				maxDurationSeconds: 150,
				maxBytes: 1024,
			})),
			transcribe: vi.fn(
				async (_audio: {
					bytes: Uint8Array;
					mimeType: string;
					durationMs: number;
				}) => "phrase",
			),
			onState: vi.fn(),
			onTranscript: vi.fn(),
			onError: vi.fn(),
		};
		return { controller: new VoiceDictation(callbacks), ...callbacks };
	};
	/** Speaks for `speakMs`, then pauses long enough to end the phrase. */
	const speakPhrase = async (speakMs = 2_000) => {
		loudness = 1;
		await vi.advanceTimersByTimeAsync(speakMs);
		loudness = 0;
		await vi.advanceTimersByTimeAsync(1_000);
	};
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		Recorder.instances = [];
		loudness = 0;
		vi.stubGlobal("navigator", {
			mediaDevices: { getUserMedia: vi.fn(async () => stream) },
		});
		vi.stubGlobal("MediaRecorder", Recorder);
		vi.stubGlobal("AudioContext", AudioContextStub);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	it("transcribes each phrase while the speaker keeps talking", async () => {
		const voice = create();
		voice.transcribe
			.mockResolvedValueOnce("first thought")
			.mockResolvedValueOnce("second thought");
		await voice.controller.start();
		await speakPhrase();
		expect(Recorder.instances).toHaveLength(2);
		expect(Recorder.instances[0]?.state).toBe("inactive");
		expect(Recorder.instances[1]?.state).toBe("recording");
		expect(voice.onTranscript).toHaveBeenCalledExactlyOnceWith("first thought");
		expect(voice.onState).toHaveBeenLastCalledWith("recording");
		loudness = 1;
		await vi.advanceTimersByTimeAsync(500);
		voice.controller.stop();
		await flush();
		expect(voice.transcribe).toHaveBeenCalledTimes(2);
		expect(voice.onTranscript).toHaveBeenLastCalledWith("second thought");
		expect(voice.onState).toHaveBeenLastCalledWith("idle");
		expect(voice.onError).not.toHaveBeenCalled();
	});
	it("does not cut a phrase on short gaps between words", async () => {
		const voice = create();
		await voice.controller.start();
		for (let word = 0; word < 6; word++) {
			loudness = 1;
			await vi.advanceTimersByTimeAsync(400);
			loudness = 0;
			await vi.advanceTimersByTimeAsync(300);
		}
		expect(Recorder.instances).toHaveLength(1);
		expect(voice.transcribe).not.toHaveBeenCalled();
		voice.controller.cancel();
	});
	it("delivers phrases in spoken order when responses race", async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		const voice = create();
		voice.transcribe
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		await voice.controller.start();
		await speakPhrase();
		loudness = 1;
		await vi.advanceTimersByTimeAsync(500);
		voice.controller.stop();
		await flush();
		second.resolve("later");
		await flush();
		expect(voice.onTranscript).not.toHaveBeenCalled();
		expect(voice.onState).toHaveBeenLastCalledWith("transcribing");
		first.resolve("earlier");
		await flush();
		expect(voice.onTranscript.mock.calls).toEqual([["earlier"], ["later"]]);
		expect(voice.onState).toHaveBeenLastCalledWith("idle");
	});
	it("sends a trailing phrase the meter heard as silence", async () => {
		const voice = create();
		voice.transcribe
			.mockResolvedValueOnce("loud part")
			.mockResolvedValueOnce("quiet part");
		await voice.controller.start();
		await speakPhrase();
		await vi.advanceTimersByTimeAsync(2_000);
		voice.controller.stop();
		await flush();
		expect(voice.transcribe).toHaveBeenCalledTimes(2);
		expect(voice.onTranscript.mock.calls).toEqual([
			["loud part"],
			["quiet part"],
		]);
		expect(voice.onState).toHaveBeenLastCalledWith("idle");
	});
	it("ends dictation as soon as a later phrase fails", async () => {
		const first = deferred<string>();
		const voice = create();
		voice.transcribe
			.mockReturnValueOnce(first.promise)
			.mockRejectedValueOnce(new Error("offline"));
		await voice.controller.start();
		await speakPhrase();
		loudness = 1;
		await vi.advanceTimersByTimeAsync(500);
		voice.controller.stop();
		await flush();
		expect(voice.onError).toHaveBeenCalledExactlyOnceWith(
			"transcription_failed",
		);
		expect(voice.onState).toHaveBeenLastCalledWith("idle");
		first.resolve("arrives after the failure");
		await flush();
		expect(voice.onTranscript).not.toHaveBeenCalled();
	});
	it("always sends the first phrase, even when the meter heard nothing", async () => {
		const voice = create();
		await voice.controller.start();
		await vi.advanceTimersByTimeAsync(3_000);
		voice.controller.stop();
		await flush();
		expect(voice.transcribe).toHaveBeenCalledTimes(1);
	});
	it("stops delivering once cancelled mid-dictation", async () => {
		const pending = deferred<string>();
		const voice = create();
		voice.transcribe.mockReturnValueOnce(pending.promise);
		await voice.controller.start();
		await speakPhrase();
		voice.controller.cancel();
		pending.resolve("too late");
		await flush();
		expect(voice.onTranscript).not.toHaveBeenCalled();
		expect(voice.onError).not.toHaveBeenCalled();
		expect(track.stop).toHaveBeenCalled();
	});
	it("ends dictation when a phrase fails to transcribe", async () => {
		const voice = create();
		voice.transcribe.mockRejectedValueOnce(new Error("offline"));
		await voice.controller.start();
		await speakPhrase();
		expect(voice.onError).toHaveBeenCalledExactlyOnceWith(
			"transcription_failed",
		);
		expect(voice.onState).toHaveBeenLastCalledWith("idle");
		expect(track.stop).toHaveBeenCalled();
	});
	it("reuses an account check started before the click", async () => {
		const voice = create();
		void voice.controller.prepare();
		await voice.controller.start();
		expect(voice.capabilities).toHaveBeenCalledTimes(1);
		voice.controller.cancel();
	});
});

describe("dictation availability", () => {
	const codex = (fields: Record<string, unknown>) =>
		({
			providerId: "codex",
			displayName: "Codex",
			cliInstalled: true,
			cliLoggedIn: true,
			hasApiKey: false,
			...fields,
		}) as AgentAvailability;
	it("is offered only for a verified ChatGPT account on Codex", () => {
		expect(
			canDictate([codex({ authStatus: "authenticated", authType: "chatgpt" })]),
		).toBe(true);
		expect(
			canDictate([codex({ authStatus: "authenticated", authType: "apiKey" })]),
		).toBe(false);
		expect(
			canDictate([codex({ authStatus: "unknown", authType: "chatgpt" })]),
		).toBe(false);
		expect(
			canDictate([
				codex({
					authStatus: "authenticated",
					authType: "chatgpt",
					status: "disabled",
				}),
			]),
		).toBe(false);
	});
	it("is hidden before provider discovery or without Codex", () => {
		expect(canDictate(undefined)).toBe(false);
		expect(
			canDictate([
				{
					...codex({ authStatus: "authenticated", authType: "chatgpt" }),
					providerId: "claude",
				},
			]),
		).toBe(false);
	});
});
