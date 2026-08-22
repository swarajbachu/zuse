import { Effect } from "effect";
import {
	AudioQuality,
	IOSOutputFormat,
	RecordingPresets,
	requestRecordingPermissionsAsync,
	setAudioModeAsync,
	useAudioRecorder,
	useAudioRecorderState,
} from "expo-audio";
import { File } from "expo-file-system";
import { Mic, Square, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Alert, AppState, Modal, Pressable, Text, View } from "react-native";

import { stopRecorderOnUnmount } from "~/lib/audio-recorder-lifecycle";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import { prewarmVoice, resolveVoiceAuth, transcribeVoice } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import { colors } from "~/theme";
import {
	beginBestEffortBackgroundTask,
	endBestEffortBackgroundTask,
} from "../../modules/mobile-platform";

const MAX_DURATION_MS = 150_000;
const MAX_BYTES = 10 * 1024 * 1024;
const WAVEFORM_BARS = [
	{ id: "outer-left", weight: 0.45 },
	{ id: "inner-left", weight: 0.72 },
	{ id: "center", weight: 1 },
	{ id: "inner-right", weight: 0.68 },
	{ id: "outer-right", weight: 0.4 },
] as const;
const RECORDING_OPTIONS = {
	...RecordingPresets.HIGH_QUALITY,
	directory: "cache" as const,
	isMeteringEnabled: true,
	sampleRate: 24_000,
	numberOfChannels: 1,
	bitRate: 64_000,
	ios: {
		...RecordingPresets.HIGH_QUALITY.ios,
		extension: ".m4a",
		sampleRate: 24_000,
		outputFormat: IOSOutputFormat.MPEG4AAC,
		audioQuality: AudioQuality.HIGH,
	},
};

type VoiceState = "idle" | "recording" | "transcribing";

const cleanRecording = (uri: string | null): void => {
	if (uri === null) return;
	const file = new File(uri);
	if (file.exists) file.delete();
};

const resetAudioMode = async (): Promise<void> => {
	await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
};

const transcriptFromBody = (body: string): string | null => {
	try {
		const parsed = JSON.parse(body) as {
			readonly text?: unknown;
			readonly transcript?: unknown;
		};
		const text =
			typeof parsed.text === "string"
				? parsed.text
				: typeof parsed.transcript === "string"
					? parsed.transcript
					: null;
		return text?.trim() || null;
	} catch {
		return null;
	}
};

const directFallback = async (options: {
	endpoint: string;
	token: string;
	accountId: string | null;
	bytes: Uint8Array;
}): Promise<string> => {
	const form = new FormData();
	const audioBuffer = new ArrayBuffer(options.bytes.byteLength);
	new Uint8Array(audioBuffer).set(options.bytes);
	form.append(
		"file",
		new Blob([audioBuffer], { type: "audio/mp4" }),
		"recording.m4a",
	);
	const response = await fetch(options.endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${options.token}`,
			...(options.accountId === null
				? {}
				: { "ChatGPT-Account-Id": options.accountId }),
			"User-Agent": "Zuse-Mobile-Voice/1",
		},
		body: form,
	});
	const body = await response.text();
	const transcript = response.ok ? transcriptFromBody(body) : null;
	if (transcript === null)
		throw new Error("Direct transcription fallback was not accepted.");
	return transcript;
};

export function ComposerVoiceButton({
	connection,
	enabled,
	online,
	onTranscript,
	onError,
}: {
	connection: WsProtocolOptions;
	enabled: boolean;
	online: boolean;
	onTranscript: (text: string) => void;
	onError: (message: string) => void;
}) {
	const [voiceState, setVoiceState] = useState<VoiceState>("idle");
	const completingRef = useRef(false);
	const finishRef = useRef<() => Promise<void>>(async () => undefined);
	const recorder = useAudioRecorder(RECORDING_OPTIONS);
	const recorderState = useAudioRecorderState(recorder, 80);

	const cancel = async () => {
		if (voiceState !== "recording") return;
		const uri = recorder.uri;
		await recorder.stop().catch(() => undefined);
		cleanRecording(uri ?? recorder.uri);
		await resetAudioMode();
		setVoiceState("idle");
	};

	const finish = async () => {
		if (voiceState !== "recording" || completingRef.current) return;
		completingRef.current = true;
		let backgroundTaskId = 0;
		const durationMs = recorder.getStatus().durationMillis;
		try {
			await recorder.stop();
			backgroundTaskId = await beginBestEffortBackgroundTask();
			const uri = recorder.uri;
			if (uri === null) throw new Error("The recording file was unavailable.");
			setVoiceState("transcribing");
			await resetAudioMode();
			const file = new File(uri);
			const bytes = await file.bytes();
			if (bytes.byteLength > MAX_BYTES)
				throw new Error("Recording exceeds the 10 MB limit.");
			const result = await Effect.runPromise(
				transcribeVoice({
					connection,
					bytes,
					mimeType: "audio/mp4",
					durationMs,
				}),
			);
			if (result._tag === "transcribed") {
				onTranscript(result.text);
			} else {
				let token: string | null = null;
				try {
					const auth = await Effect.runPromise(
						resolveVoiceAuth({ connection, ticket: result.ticket }),
					);
					token = auth.token;
					onTranscript(
						await directFallback({
							endpoint: auth.endpoint,
							token,
							accountId: auth.accountId,
							bytes,
						}),
					);
				} finally {
					token = null;
				}
			}
			cleanRecording(uri);
			setVoiceState("idle");
		} catch (cause) {
			cleanRecording(recorder.uri);
			setVoiceState("idle");
			onError(connectionErrorMessage(cause));
		} finally {
			await endBestEffortBackgroundTask(backgroundTaskId);
			completingRef.current = false;
		}
	};
	finishRef.current = finish;

	useEffect(() => {
		if (
			voiceState === "recording" &&
			recorderState.durationMillis >= MAX_DURATION_MS
		)
			void finishRef.current();
	}, [recorderState.durationMillis, voiceState]);

	useEffect(() => {
		const subscription = AppState.addEventListener("change", (next) => {
			if (next !== "active" && voiceState === "recording")
				void finishRef.current();
		});
		return () => subscription.remove();
	}, [voiceState]);

	useEffect(
		() => () => {
			void stopRecorderOnUnmount(recorder);
			void resetAudioMode();
		},
		[recorder],
	);

	const start = async () => {
		if (!enabled || !online || voiceState !== "idle") return;
		try {
			const permission = await requestRecordingPermissionsAsync();
			if (!permission.granted) {
				Alert.alert(
					"Microphone access needed",
					"Allow microphone access in Settings to dictate a message.",
				);
				return;
			}
			await Promise.all([
				setAudioModeAsync({
					allowsRecording: true,
					playsInSilentMode: true,
					interruptionMode: "doNotMix",
				}),
				Effect.runPromise(prewarmVoice({ connection })),
			]);
			await recorder.prepareToRecordAsync();
			recorder.record({ forDuration: MAX_DURATION_MS / 1_000 });
			setVoiceState("recording");
		} catch (cause) {
			await resetAudioMode();
			onError(connectionErrorMessage(cause));
		}
	};

	if (!enabled) return null;

	const seconds = Math.min(
		150,
		Math.floor(recorderState.durationMillis / 1_000),
	);
	const level = Math.max(
		0.08,
		Math.min(1, ((recorderState.metering ?? -60) + 60) / 60),
	);

	return (
		<>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel="Dictate message"
				disabled={!online || voiceState !== "idle"}
				onPress={() => void start()}
				className="h-10 w-10 items-center justify-center rounded-2xl active:bg-muted"
			>
				<Mic size={19} color={online ? colors.fg : colors.tertiaryFg} />
			</Pressable>
			<Modal
				transparent
				visible={voiceState !== "idle"}
				animationType="fade"
				onRequestClose={() => void cancel()}
			>
				<View
					pointerEvents="box-none"
					className="flex-1 items-center justify-end px-4 pb-28"
				>
					<View className="min-h-16 w-full max-w-sm flex-row items-center gap-3 rounded-3xl border border-border bg-card px-3 py-2 shadow-lg">
						{voiceState === "transcribing" ? (
							<>
								<View className="h-3 w-3 rounded-full bg-accent" />
								<Text className="flex-1 font-sans-medium text-sm text-foreground">
									Transcribing…
								</Text>
							</>
						) : (
							<>
								<Pressable
									accessibilityRole="button"
									accessibilityLabel="Cancel recording"
									onPress={() => void cancel()}
									className="h-11 w-11 items-center justify-center rounded-full bg-muted"
								>
									<X size={18} color={colors.fg} />
								</Pressable>
								<Text
									className="w-10 font-mono text-xs text-foreground"
									style={{ fontVariant: ["tabular-nums"] }}
								>
									{Math.floor(seconds / 60)}:
									{String(seconds % 60).padStart(2, "0")}
								</Text>
								<View className="h-8 flex-1 flex-row items-center justify-center gap-1">
									{WAVEFORM_BARS.map(({ id, weight }) => (
										<View
											key={id}
											className="w-1 rounded-full bg-accent"
											style={{ height: 6 + 24 * level * weight }}
										/>
									))}
								</View>
								<Pressable
									accessibilityRole="button"
									accessibilityLabel="Stop and transcribe"
									onPress={() => void finish()}
									className="h-11 w-11 items-center justify-center rounded-full bg-accent"
								>
									<Square
										size={15}
										fill={colors.primaryForeground}
										color={colors.primaryForeground}
									/>
								</Pressable>
							</>
						)}
					</View>
				</View>
			</Modal>
		</>
	);
}
