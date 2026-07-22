export type BrowserRecordingState =
	| "idle"
	| "starting"
	| "recording"
	| "stopping";

export interface BrowserRecordingArtifact {
	readonly id: string;
	readonly type: string;
	readonly size: number;
	readonly durationMs: number;
	readonly createdAt: string;
}

interface CaptureImage {
	isEmpty(): boolean;
	toDataURL(): string;
}

export interface BrowserRecordingSource {
	capturePage(): Promise<CaptureImage>;
	getBoundingClientRect(): DOMRect;
	subscribeFrames?(
		handler: (dataUrl: string) => void,
	): Promise<() => void | Promise<void>>;
	drawDecorations?(
		context: CanvasRenderingContext2D,
		width: number,
		height: number,
	): void;
}

const MAX_DURATION_MS = 10 * 60 * 1000;
const MAX_BYTES = 300 * 1024 * 1024;
const FRAME_INTERVAL_MS = 100;

const supportedMimeType = (): string => {
	for (const candidate of [
		"video/mp4;codecs=avc1",
		"video/webm;codecs=vp9",
		"video/webm;codecs=vp8",
		"video/webm",
	]) {
		if (MediaRecorder.isTypeSupported(candidate)) return candidate;
	}
	return "";
};

const loadFrame = (dataUrl: string): Promise<HTMLImageElement> =>
	new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () =>
			reject(new Error("Could not decode a browser frame."));
		image.src = dataUrl;
	});

export class BrowserRecordingController {
	state: BrowserRecordingState = "idle";
	startedAt: number | null = null;
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private chunkBytes = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private capTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeFrames: (() => void | Promise<void>) | null = null;
	private drawing = false;
	private stopPromise: Promise<BrowserRecordingArtifact> | null = null;

	async start(source: BrowserRecordingSource): Promise<void> {
		if (this.state !== "idle")
			throw new Error("A browser recording is already active.");
		if (
			source.getBoundingClientRect().width < 1 ||
			source.getBoundingClientRect().height < 1
		) {
			throw new Error("The browser must be visible before recording starts.");
		}
		this.state = "starting";
		try {
			const first = await Promise.race([
				source.capturePage(),
				new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(new Error("Browser recording did not receive a frame.")),
						3000,
					),
				),
			]);
			if (first.isEmpty()) {
				this.state = "idle";
				throw new Error("The first browser recording frame was empty.");
			}
			const frame = await loadFrame(first.toDataURL());
			const canvas = document.createElement("canvas");
			canvas.width = frame.naturalWidth;
			canvas.height = frame.naturalHeight;
			const context = canvas.getContext("2d", { alpha: false });
			if (context === null) throw new Error("Canvas recording is unavailable.");
			context.drawImage(frame, 0, 0);
			source.drawDecorations?.(context, canvas.width, canvas.height);
			const stream = canvas.captureStream(10);
			const mimeType = supportedMimeType();
			this.chunks = [];
			this.chunkBytes = 0;
			this.recorder = new MediaRecorder(
				stream,
				mimeType === "" ? undefined : { mimeType },
			);
			this.recorder.ondataavailable = (event) => {
				if (event.data.size <= 0) return;
				if (this.chunkBytes + event.data.size > MAX_BYTES) {
					void this.stop().catch(() => {});
					return;
				}
				this.chunks.push(event.data);
				this.chunkBytes += event.data.size;
			};
			this.recorder.start(1000);
			this.startedAt = Date.now();
			this.state = "recording";
			const drawFrame = (dataUrl: string) => {
				if (this.drawing || this.state !== "recording") return;
				this.drawing = true;
				void loadFrame(dataUrl)
					.then((next) => {
						context.drawImage(next, 0, 0, canvas.width, canvas.height);
						source.drawDecorations?.(context, canvas.width, canvas.height);
					})
					.catch(() => {})
					.finally(() => {
						this.drawing = false;
					});
			};
			if (source.subscribeFrames !== undefined) {
				try {
					this.unsubscribeFrames = await source.subscribeFrames(drawFrame);
				} catch {
					this.unsubscribeFrames = null;
				}
			}
			if (this.unsubscribeFrames === null) {
				this.timer = setInterval(() => {
					void source
						.capturePage()
						.then((image) => {
							if (!image.isEmpty()) drawFrame(image.toDataURL());
						})
						.catch(() => {});
				}, FRAME_INTERVAL_MS);
			}
			this.capTimer = setTimeout(() => void this.stop(), MAX_DURATION_MS);
		} catch (error) {
			this.state = "idle";
			this.startedAt = null;
			this.recorder = null;
			throw error;
		}
	}

	stop(): Promise<BrowserRecordingArtifact> {
		if (this.state === "idle" || this.recorder === null) {
			return Promise.reject(new Error("No browser recording is active."));
		}
		if (this.stopPromise !== null) return this.stopPromise;
		this.stopPromise = this.finish();
		return this.stopPromise;
	}

	private async finish(): Promise<BrowserRecordingArtifact> {
		if (this.recorder === null || this.startedAt === null)
			throw new Error("No browser recording is active.");
		this.state = "stopping";
		if (this.timer !== null) clearInterval(this.timer);
		if (this.capTimer !== null) clearTimeout(this.capTimer);
		if (this.unsubscribeFrames !== null) await this.unsubscribeFrames();
		const recorder = this.recorder;
		await new Promise<void>((resolve) => {
			recorder.addEventListener("stop", () => resolve(), { once: true });
			recorder.stop();
		});
		try {
			const durationMs = Date.now() - this.startedAt;
			const blob = new Blob(this.chunks, {
				type: recorder.mimeType || "video/webm",
			});
			if (blob.size > MAX_BYTES)
				throw new Error("Browser recording exceeded 300 MB.");
			const save = window.zuse?.browser?.saveRecording;
			if (save === undefined)
				throw new Error("Recording artifacts are unavailable in this build.");
			return await save(
				new Uint8Array(await blob.arrayBuffer()),
				blob.type,
				durationMs,
			);
		} finally {
			this.state = "idle";
			this.startedAt = null;
			this.recorder = null;
			this.chunks = [];
			this.chunkBytes = 0;
			this.timer = null;
			this.capTimer = null;
			this.unsubscribeFrames = null;
			this.stopPromise = null;
		}
	}
}
