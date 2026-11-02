import "@zuse/i18n/english/chat";
import type { EnvironmentId } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Effect } from "effect";
import { Check, Mic, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { getAppBridge } from "~/lib/bridge";
import { runRuntimeOperation } from "~/lib/runtime-operation-client";
import { cn } from "~/lib/utils";
import {
	canDictate,
	type DictationErrorCode,
	type DictationState,
	VoiceDictation,
} from "~/lib/voice-dictation";
import { transcribeRecording } from "~/lib/voice-transcription";
import { useProvidersStore } from "~/store/providers";

/** Relative bar heights, tallest in the middle, so the meter reads as a voice. */
const LEVEL_BARS = [0.5, 0.8, 1, 0.75, 0.45] as const;
/** The timer warns when this little recording time is left. */
const WARN_REMAINING_MS = 10_000;

const ERROR_MESSAGE_KEYS = {
	unsupported: "chat:voice_error_unsupported",
	account_required: "chat:voice_error_account_required",
	format_unsupported: "chat:voice_error_unsupported",
	permission_denied: "chat:voice_error_permission_denied",
	no_microphone: "chat:voice_error_no_microphone",
	too_large: "chat:voice_error_too_large",
	recorder_failed: "chat:voice_error_recorder_failed",
	no_audio: "chat:voice_error_no_speech",
	no_speech: "chat:voice_error_no_speech",
	transcription_failed: "chat:voice_error_transcription_failed",
	service_unavailable: "chat:voice_error_service_unavailable",
	start_failed: "chat:voice_error_start_failed",
} as const satisfies Record<DictationErrorCode, string>;

const formatElapsed = (ms: number) => {
	const seconds = Math.floor(ms / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const pillButtonClass =
	"flex size-6 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ComposerVoiceButton({
	environmentId,
	disabled,
	onTranscript,
}: {
	environmentId: EnvironmentId;
	disabled: boolean;
	onTranscript: (text: string) => void;
}) {
	const { message } = useMessages("chat");
	const messageRef = useRef(message);
	messageRef.current = message;
	const [state, setState] = useState<DictationState>("idle");
	const controller = useRef<VoiceDictation | null>(null);
	const transcriptRef = useRef(onTranscript);
	transcriptRef.current = onTranscript;
	const available = useProvidersStore((s) =>
		canDictate(s.availabilityByEnvironment[environmentId]?.availability),
	);
	const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
	const timerRef = useRef<HTMLSpanElement | null>(null);

	useEffect(() => {
		const dictation = new VoiceDictation({
			capabilities: () =>
				runRuntimeOperation(environmentId, (client) =>
					client["voice.capabilities"]({}).pipe(Effect.timeout(15_000)),
				),
			transcribe: (audio) =>
				transcribeRecording(audio, {
					transcribe: (recording) =>
						runRuntimeOperation(environmentId, (client) =>
							client["voice.transcribe"](recording).pipe(
								Effect.timeout(60_000),
							),
						),
					resolveAuth: (ticket) =>
						runRuntimeOperation(environmentId, (client) =>
							client["voice.resolveAuth"]({ ticket }).pipe(
								Effect.timeout(15_000),
							),
						),
					direct: getAppBridge()?.transcribeVoice,
				}),
			onState: setState,
			onTranscript: (text) => transcriptRef.current(text),
			onError: (code) =>
				toastManager.add({
					type: "error",
					title: messageRef.current(ERROR_MESSAGE_KEYS[code]),
				}),
		});
		controller.current = dictation;
		return () => {
			dictation.cancel();
			controller.current = null;
		};
	}, [environmentId]);

	// Shared, deduplicated provider discovery; usually already loaded.
	useEffect(() => {
		void useProvidersStore.getState().loadFor(environmentId);
	}, [environmentId]);

	useEffect(() => {
		if (disabled || !available) controller.current?.cancel();
	}, [disabled, available]);

	const active = state === "recording" || state === "transcribing";

	// Escape abandons dictation, matching how it dismisses other composer UI.
	useEffect(() => {
		if (!active) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			event.stopPropagation();
			controller.current?.cancel();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [active]);

	// Drive the meter and timer straight from the DOM: a re-render per frame
	// would put the whole composer on the animation loop.
	useEffect(() => {
		if (state !== "recording") return;
		let smoothed = 0;
		let frame = requestAnimationFrame(function tick() {
			const meter = controller.current?.meter();
			if (!meter) return;
			smoothed = smoothed * 0.6 + meter.level * 0.4;
			LEVEL_BARS.forEach((weight, index) => {
				const bar = barRefs.current[index];
				if (bar) bar.style.scale = `1 ${Math.max(0.2, smoothed * weight)}`;
			});
			const timer = timerRef.current;
			if (timer) {
				timer.textContent = formatElapsed(meter.elapsedMs);
				timer.dataset.warn = String(meter.remainingMs <= WARN_REMAINING_MS);
			}
			frame = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(frame);
	}, [state]);

	if (!available) return null;

	if (!active) {
		const starting = state === "starting";
		const label = starting
			? message("chat:voice_starting")
			: message("chat:voice_dictate");
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							aria-label={label}
							disabled={disabled || starting}
							onClick={() => void controller.current?.start()}
							// Confirm the account while the pointer is on its way, so
							// the click goes straight to the microphone.
							onPointerEnter={() => void controller.current?.prepare()}
							onFocus={() => void controller.current?.prepare()}
							className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
						>
							{starting ? (
								<Spinner className="size-3.5" />
							) : (
								<Mic className="size-3.5" />
							)}
						</button>
					}
				/>
				<TooltipPopup>{label}</TooltipPopup>
			</Tooltip>
		);
	}

	const recording = state === "recording";
	return (
		<div className="flex h-7 items-center gap-1.5 rounded-full bg-muted/60 px-0.5">
			<button
				type="button"
				aria-label={message("chat:voice_cancel")}
				title={message("chat:voice_cancel")}
				onClick={() => controller.current?.cancel()}
				className={cn(
					pillButtonClass,
					"text-muted-foreground hover:bg-muted hover:text-foreground",
				)}
			>
				<X className="size-3.5" />
			</button>
			<span role="status" className="sr-only">
				{recording
					? message("chat:voice_listening")
					: message("chat:voice_transcribing")}
			</span>
			{recording ? (
				<>
					<span aria-hidden className="flex h-3.5 items-center gap-0.5">
						{LEVEL_BARS.map((weight, index) => (
							<span
								key={weight}
								ref={(node) => {
									barRefs.current[index] = node;
								}}
								className="h-full w-0.5 origin-center scale-y-20 rounded-full bg-foreground transition-[scale] duration-75"
							/>
						))}
					</span>
					<span
						ref={timerRef}
						aria-hidden
						data-warn="false"
						className="min-w-7 text-xs tabular-nums text-muted-foreground data-[warn=true]:text-destructive"
					>
						0:00
					</span>
					<button
						type="button"
						aria-label={message("chat:voice_stop")}
						title={message("chat:voice_stop")}
						onClick={() => controller.current?.stop()}
						className={cn(
							pillButtonClass,
							"bg-foreground text-background hover:bg-foreground/85",
						)}
					>
						<Check className="size-3.5" strokeWidth={2.5} />
					</button>
				</>
			) : (
				<span
					aria-hidden
					className="flex items-center gap-1.5 pr-2 text-xs text-muted-foreground"
				>
					<Spinner className="size-3" />
					{message("chat:voice_transcribing")}
				</span>
			)}
		</div>
	);
}
