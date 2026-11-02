import type { AgentAvailability } from "@zuse/contracts";

export type DictationState = "idle" | "starting" | "recording" | "transcribing";
export type DictationErrorCode =
	| "unsupported"
	| "account_required"
	| "format_unsupported"
	| "permission_denied"
	| "no_microphone"
	| "too_large"
	| "recorder_failed"
	| "no_audio"
	| "no_speech"
	| "transcription_failed"
	| "service_unavailable"
	| "start_failed";

/** A failure the UI can describe; any other thrown value maps to a generic code. */
export class DictationError extends Error {
	constructor(readonly code: DictationErrorCode) {
		super(code);
	}
}

/**
 * Transcription runs through the ChatGPT account Codex is signed in with, so
 * dictation exists only where that account is verified. Unknown auth counts as
 * unavailable: a control that cannot work should not be offered.
 */
export const canDictate = (
	availability: ReadonlyArray<AgentAvailability> | undefined,
): boolean =>
	availability?.some(
		(provider) =>
			provider.providerId === "codex" &&
			provider.status !== "disabled" &&
			provider.authStatus === "authenticated" &&
			provider.authType === "chatgpt",
	) ?? false;

export interface DictationMeter {
	/** Input loudness from 0 (silence) to 1. */
	level: number;
	elapsedMs: number;
	remainingMs: number;
}
export interface VoiceLimits {
	available: boolean;
	maxDurationSeconds: number;
	maxBytes: number;
}

/** A pause this long ends a phrase; shorter gaps fall between words. */
const PAUSE_MS = 800;
/** Phrases grow to at least this length: tiny clips transcribe poorly. */
const MIN_PHRASE_MS = 1_500;
const PAUSE_POLL_MS = 100;
/** Meter level that counts as speech rather than room noise. */
const SPEECH_LEVEL = 0.08;
/** A confirmed account is reused briefly so a click skips the round trip. */
const LIMITS_REUSE_MS = 30_000;

interface Phrase {
	readonly recorder: MediaRecorder;
	readonly startedAt: number;
	heardSpeech: boolean;
}

/**
 * Owns microphone lifetime; cancelled work can never deliver a late transcript.
 *
 * Audio is cut into phrases at natural pauses. Each phrase is transcribed
 * while the speaker keeps talking and delivered in spoken order, so text
 * appears during dictation and stopping waits only for the final phrase.
 */
export class VoiceDictation {
	private generation = 0;
	private state: DictationState = "idle";
	private phrase: Phrase | null = null;
	private stream: MediaStream | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private pausePoll: ReturnType<typeof setInterval> | null = null;
	private quietSince: number | null = null;
	private startedAt = 0;
	private limitMs = 0;
	private recordedBytes = 0;
	private delivered = false;
	/** Settles once every phrase begun so far has been delivered or skipped. */
	private delivery: Promise<void> = Promise.resolve();
	private limits: { value: Promise<VoiceLimits>; at: number } | null = null;
	private analyser: {
		context: AudioContext;
		node: AnalyserNode;
		samples: Uint8Array<ArrayBuffer>;
	} | null = null;

	constructor(
		private readonly options: {
			capabilities: () => Promise<VoiceLimits>;
			transcribe: (audio: {
				bytes: Uint8Array;
				mimeType: string;
				durationMs: number;
			}) => Promise<string>;
			onState: (state: DictationState) => void;
			onTranscript: (text: string) => void;
			onError: (code: DictationErrorCode) => void;
		},
	) {}

	private setState(state: DictationState) {
		this.state = state;
		this.options.onState(state);
	}

	/** Checks the account ahead of a click, e.g. on hover, so recording starts at once. */
	prepare(): Promise<VoiceLimits> {
		const now = performance.now();
		if (this.limits !== null && now - this.limits.at < LIMITS_REUSE_MS)
			return this.limits.value;
		const entry = { value: this.options.capabilities(), at: now };
		this.limits = entry;
		const forget = () => {
			if (this.limits === entry) this.limits = null;
		};
		entry.value.then((limits) => {
			if (!limits.available) forget();
		}, forget);
		return entry.value;
	}

	private inputLevel(): number {
		if (this.analyser === null) return 0;
		const { node, samples } = this.analyser;
		node.getByteTimeDomainData(samples);
		let sum = 0;
		for (const sample of samples) {
			const centered = (sample - 128) / 128;
			sum += centered * centered;
		}
		// Speech RMS rarely exceeds ~0.3; scale so normal speaking fills the meter.
		return Math.min(1, Math.sqrt(sum / samples.length) * 4);
	}

	/** Live input level and time budget while recording; null otherwise. */
	meter(): DictationMeter | null {
		if (this.state !== "recording") return null;
		const elapsedMs = Math.max(0, performance.now() - this.startedAt);
		return {
			level: this.inputLevel(),
			elapsedMs,
			remainingMs: Math.max(0, this.limitMs - elapsedMs),
		};
	}

	private releaseInput() {
		if (this.pausePoll !== null) clearInterval(this.pausePoll);
		this.pausePoll = null;
		const analyser = this.analyser;
		this.analyser = null;
		void analyser?.context.close().catch(() => undefined);
		this.stream?.getTracks().forEach((track) => {
			track.onended = null;
			track.stop();
		});
	}

	private release() {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		const recorder = this.phrase?.recorder;
		this.phrase = null;
		if (recorder !== undefined) {
			recorder.onstop = null;
			recorder.ondataavailable = null;
			recorder.onerror = null;
			if (recorder.state !== "inactive") recorder.stop();
		}
		this.releaseInput();
		this.stream = null;
	}

	cancel() {
		this.generation++;
		this.release();
		this.setState("idle");
	}

	stop() {
		if (this.state !== "recording") return;
		const generation = this.generation;
		this.setState("transcribing");
		const recorder = this.phrase?.recorder;
		if (recorder?.state === "recording") recorder.stop();
		// Release the hardware immediately, before waiting for transcription.
		this.releaseInput();
		// Every phrase is already queued, so this runs after the final one lands.
		void this.delivery.then(() => {
			if (generation !== this.generation) return;
			this.release();
			if (!this.delivered) {
				this.fail(this.recordedBytes === 0 ? "no_audio" : "no_speech");
				return;
			}
			this.setState("idle");
		});
	}

	private fail(code: DictationErrorCode) {
		this.cancel();
		this.options.onError(code);
	}

	private attachAnalyser(stream: MediaStream) {
		// Metering is cosmetic; recording must not depend on Web Audio.
		if (typeof AudioContext === "undefined") return;
		try {
			const context = new AudioContext();
			const node = context.createAnalyser();
			node.fftSize = 512;
			context.createMediaStreamSource(stream).connect(node);
			this.analyser = {
				context,
				node,
				samples: new Uint8Array(node.fftSize),
			};
		} catch {
			this.analyser = null;
		}
	}

	/**
	 * Records the next phrase on the shared stream. Its delivery slot is
	 * reserved now, so phrases land in spoken order however their requests race.
	 */
	private beginPhrase(
		stream: MediaStream,
		mimeType: string,
		maxBytes: number,
		current: () => boolean,
	): void {
		const fail = (code: DictationErrorCode) => {
			if (current()) this.fail(code);
		};
		const recorder = new MediaRecorder(stream, {
			mimeType,
			audioBitsPerSecond: 64_000,
		});
		const phrase: Phrase = {
			recorder,
			startedAt: performance.now(),
			heardSpeech: false,
		};
		const chunks: Blob[] = [];
		let finished!: (audio: { blob: Blob; durationMs: number } | null) => void;
		const audio = new Promise<{ blob: Blob; durationMs: number } | null>(
			(resolve) => {
				finished = resolve;
			},
		);
		recorder.ondataavailable = ({ data }) => {
			if (!current() || data.size === 0) return;
			this.recordedBytes += data.size;
			if (this.recordedBytes > maxBytes) {
				fail("too_large");
				return;
			}
			chunks.push(data);
		};
		recorder.onerror = () => fail("recorder_failed");
		recorder.onstop = () => {
			const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
			// The meter only decides where to cut; quiet speech it missed is
			// still sent, and the service returns no text for silence.
			finished(
				blob.size === 0
					? null
					: {
							blob,
							durationMs: Math.max(
								1,
								Math.min(performance.now() - phrase.startedAt, this.limitMs),
							),
						},
			);
		};
		const text = audio.then(async (recording) => {
			if (recording === null || !current()) return "";
			const bytes = new Uint8Array(await recording.blob.arrayBuffer());
			if (!current()) return "";
			return this.options.transcribe({
				bytes,
				mimeType: recording.blob.type,
				durationMs: recording.durationMs,
			});
		});
		// A failure ends dictation at once rather than after earlier phrases land.
		const transcript = text.catch((error: unknown) => {
			fail(
				error instanceof DictationError ? error.code : "transcription_failed",
			);
			return "";
		});
		this.delivery = this.delivery
			.then(() => transcript)
			.then((spoken) => {
				const trimmed = spoken.trim();
				if (!current() || trimmed === "") return;
				this.delivered = true;
				this.options.onTranscript(trimmed);
			});
		recorder.start(250);
		this.phrase = phrase;
	}

	/** Cuts the phrase once the speaker pauses, so it transcribes while they go on. */
	private watchForPauses(
		stream: MediaStream,
		mimeType: string,
		maxBytes: number,
		current: () => boolean,
	) {
		if (this.analyser === null) return;
		this.pausePoll = setInterval(() => {
			const phrase = this.phrase;
			if (phrase === null || this.state !== "recording") return;
			const now = performance.now();
			if (this.inputLevel() >= SPEECH_LEVEL) {
				phrase.heardSpeech = true;
				this.quietSince = null;
				return;
			}
			this.quietSince ??= now;
			if (
				!phrase.heardSpeech ||
				now - this.quietSince < PAUSE_MS ||
				now - phrase.startedAt < MIN_PHRASE_MS
			)
				return;
			// Start the next recorder before stopping this one so no audio is lost.
			this.beginPhrase(stream, mimeType, maxBytes, current);
			phrase.recorder.stop();
			this.quietSince = null;
		}, PAUSE_POLL_MS);
	}

	async start() {
		if (this.state !== "idle") return;
		const generation = ++this.generation;
		const current = () => generation === this.generation;
		this.setState("starting");
		try {
			if (
				!globalThis.navigator?.mediaDevices?.getUserMedia ||
				typeof MediaRecorder === "undefined"
			) {
				throw new DictationError("unsupported");
			}
			const limits = await this.prepare();
			if (!current()) return;
			if (!limits.available) throw new DictationError("account_required");
			const mimeType = [
				"audio/webm;codecs=opus",
				"audio/webm",
				"audio/mp4",
			].find((type) => MediaRecorder.isTypeSupported(type));
			if (!mimeType) throw new DictationError("format_unsupported");
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (!current()) {
				stream.getTracks().forEach((track) => {
					track.stop();
				});
				return;
			}
			this.stream = stream;
			this.recordedBytes = 0;
			this.delivered = false;
			this.quietSince = null;
			this.delivery = Promise.resolve();
			this.limitMs = limits.maxDurationSeconds * 1000;
			stream.getTracks().forEach((track) => {
				track.onended = () => this.stop();
			});
			this.attachAnalyser(stream);
			this.beginPhrase(stream, mimeType, limits.maxBytes, current);
			this.startedAt = performance.now();
			this.setState("recording");
			this.watchForPauses(stream, mimeType, limits.maxBytes, current);
			this.timer = setTimeout(() => this.stop(), this.limitMs);
		} catch (error) {
			if (current()) this.fail(startErrorCode(error));
		}
	}
}

const startErrorCode = (error: unknown): DictationErrorCode => {
	if (error instanceof DictationError) return error.code;
	if (error instanceof DOMException) {
		if (error.name === "NotAllowedError" || error.name === "SecurityError")
			return "permission_denied";
		if (error.name === "NotFoundError" || error.name === "NotReadableError")
			return "no_microphone";
	}
	return "start_failed";
};
