import { useAtomValue } from "@effect/atom-react";
import { createTerminalInputPump } from "@zuse/client-runtime/terminal-input-pump";
import type { PtyId, PtySummary } from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import * as Linking from "expo-linking";
import { Stack, useLocalSearchParams } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { Minus, Plus, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { getOrCreateDeviceId } from "~/lib/device-identity";
import {
	type TerminalInputEvent,
	type TerminalLinkEvent,
	type TerminalResizeEvent,
	ZuseMobileTerminalView,
} from "~/native/mobile-terminal";
import {
	closeTerminal,
	listOwnedTerminals,
	openMobileTerminal,
	resizeTerminal,
	streamTerminalOutput,
	writeTerminal,
} from "~/rpc/actions";
import {
	connectionSnapshotAtom,
	watchConnection,
} from "~/store/connection-runtime";
import { connectionsAtom } from "~/store/connections";
import { colors } from "~/theme";

type RuntimeStatus =
	| "connecting"
	| "running"
	| "reconnecting"
	| "exited"
	| "failed";

const INPUT_ACK_TIMEOUT_MS = 3_000;
const RESIZE_DEBOUNCE_MS = 75;

const accessoryKeys = [
	{ label: "Esc", data: "\u001b" },
	{ label: "Tab", data: "\t" },
	{ label: "←", data: "\u001b[D" },
	{ label: "↑", data: "\u001b[A" },
	{ label: "↓", data: "\u001b[B" },
	{ label: "→", data: "\u001b[C" },
	{ label: "~", data: "~" },
	{ label: "|", data: "|" },
	{ label: "/", data: "/" },
] as const;

const paramValue = (value: string | string[] | undefined): string =>
	Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export default function MobileTerminalScreen() {
	const params = useLocalSearchParams<{
		conn?: string | string[];
		sessionId?: string | string[];
		cwd?: string | string[];
		label?: string | string[];
	}>();
	const connKey = normalizeConnParam(params.conn);
	const cwd = paramValue(params.cwd);
	const label = paramValue(params.label) || "Terminal";
	const connections = useAtomValue(connectionsAtom);
	const options = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const connectionSnapshot = useAtomValue(connectionSnapshotAtom(connKey));
	const insets = useSafeAreaInsets();
	const [ownerId, setOwnerId] = useState<string | null>(null);
	const [terminals, setTerminals] = useState<readonly PtySummary[]>([]);
	const [activeId, setActiveId] = useState<PtyId | null>(null);
	const [status, setStatus] = useState<RuntimeStatus>("connecting");
	const [error, setError] = useState<string | null>(null);
	const [feed, setFeed] = useState<string | undefined>();
	const [fontSize, setFontSize] = useState(12);
	const [focusNonce, setFocusNonce] = useState(1);
	const [controlNonce, setControlNonce] = useState(0);
	const lastSequenceRef = useRef(0);
	const lastActiveIdRef = useRef<PtyId | null>(null);
	const sequenceByPtyRef = useRef(new Map<PtyId, number>());
	const streamEpochRef = useRef(0);
	const inputPumpRef = useRef<ReturnType<
		typeof createTerminalInputPump
	> | null>(null);
	const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const sizeRef = useRef({ cols: 80, rows: 24 });

	useEffect(() => {
		void ScreenOrientation.lockAsync(
			ScreenOrientation.OrientationLock.ALL,
		).catch(() => undefined);
		return () => {
			void ScreenOrientation.lockAsync(
				ScreenOrientation.OrientationLock.PORTRAIT_UP,
			).catch(() => undefined);
		};
	}, []);

	useEffect(() => {
		if (options === null) return;
		return watchConnection(connKey, options);
	}, [connKey, options]);

	useEffect(() => {
		void getOrCreateDeviceId()
			.then(setOwnerId)
			.catch((cause) => {
				setError(connectionErrorMessage(cause));
				setStatus("failed");
			});
	}, []);

	const refreshTerminals = useCallback(async () => {
		if (options === null || ownerId === null) return [];
		const rows = await Effect.runPromise(
			listOwnedTerminals({ connection: options, ownerId }),
		);
		setTerminals(rows);
		return rows;
	}, [options, ownerId]);

	const openNewTerminal = useCallback(async () => {
		if (options === null || ownerId === null || cwd.length === 0) return;
		setError(null);
		setStatus("connecting");
		try {
			const result = await Effect.runPromise(
				openMobileTerminal({
					connection: options,
					ownerId,
					cwd,
					label,
					cols: sizeRef.current.cols,
					rows: sizeRef.current.rows,
				}),
			);
			await refreshTerminals();
			setActiveId(result.ptyId);
		} catch (cause) {
			setStatus("failed");
			setError(connectionErrorMessage(cause));
		}
	}, [cwd, label, options, ownerId, refreshTerminals]);

	useEffect(() => {
		if (options === null || ownerId === null) return;
		let active = true;
		void refreshTerminals()
			.then((rows) => {
				if (!active) return;
				const existing = rows.find(
					(item) => item.status === "running" && item.cwd === cwd,
				);
				if (existing !== undefined) setActiveId(existing.ptyId);
				else void openNewTerminal();
			})
			.catch((cause) => {
				if (!active) return;
				setStatus("failed");
				setError(connectionErrorMessage(cause));
			});
		return () => {
			active = false;
		};
	}, [cwd, openNewTerminal, options, ownerId, refreshTerminals]);

	useEffect(() => {
		inputPumpRef.current?.dispose();
		inputPumpRef.current = null;
		if (options === null || activeId === null || ownerId === null) return;
		if (lastActiveIdRef.current !== activeId) {
			lastActiveIdRef.current = activeId;
			lastSequenceRef.current = 0;
			sequenceByPtyRef.current.set(activeId, 0);
			setFeed(undefined);
		} else {
			lastSequenceRef.current = sequenceByPtyRef.current.get(activeId) ?? 0;
		}

		const epoch = ++streamEpochRef.current;
		setStatus(connectionSnapshot?.generation ? "reconnecting" : "connecting");
		setError(null);
		inputPumpRef.current = createTerminalInputPump({
			timeoutMs: INPUT_ACK_TIMEOUT_MS,
			write: (data) =>
				Effect.runPromise(
					writeTerminal({
						connection: options,
						ptyId: activeId,
						ownerId,
						data,
					}),
				),
			onFailure: (reason) => {
				if (epoch !== streamEpochRef.current) return;
				setStatus("failed");
				setError(
					reason === "write-timeout"
						? "The terminal stopped acknowledging input."
						: "Terminal input could not be delivered.",
				);
			},
		});

		const program = Stream.runForEach(
			streamTerminalOutput({
				connection: options,
				ptyId: activeId,
				ownerId,
				afterSequence: lastSequenceRef.current,
			}),
			(event) =>
				Effect.sync(() => {
					if (epoch !== streamEpochRef.current) return;
					if (event._tag === "gap") {
						setStatus("failed");
						setError("Terminal output history is no longer available.");
						return;
					}
					if (event._tag === "cursor") {
						if (event.sequence !== lastSequenceRef.current) {
							setStatus("failed");
							setError("Terminal replay cursor did not match.");
							return;
						}
						setStatus("running");
						setFocusNonce((value) => value + 1);
						return;
					}
					if (event.sequence <= lastSequenceRef.current) return;
					if (event.sequence !== lastSequenceRef.current + 1) {
						setStatus("reconnecting");
						return;
					}
					lastSequenceRef.current = event.sequence;
					sequenceByPtyRef.current.set(activeId, event.sequence);
					if (event._tag === "data") {
						setFeed(`${event.sequence}\u0000${event.bytes}`);
						setStatus("running");
						return;
					}
					setFeed(
						`${event.sequence}\u0000\r\n\u001b[38;5;244m[process exited${
							event.exitCode === null ? "" : ` with code ${event.exitCode}`
						}]\u001b[0m\r\n`,
					);
					setStatus("exited");
					void refreshTerminals();
				}),
		).pipe(
			Effect.catch((cause) =>
				Effect.sync(() => {
					if (epoch !== streamEpochRef.current) return;
					setStatus("reconnecting");
					setError(connectionErrorMessage(cause));
				}),
			),
		);
		const fiber = Effect.runFork(program);
		return () => {
			streamEpochRef.current += 1;
			inputPumpRef.current?.dispose();
			inputPumpRef.current = null;
			void Effect.runPromise(Fiber.interrupt(fiber));
		};
	}, [
		activeId,
		connectionSnapshot?.generation,
		options,
		ownerId,
		refreshTerminals,
	]);

	const onInput = (event: TerminalInputEvent) => {
		inputPumpRef.current?.enqueue(event.nativeEvent.data);
	};

	const onResize = (event: TerminalResizeEvent) => {
		sizeRef.current = {
			cols: event.nativeEvent.cols,
			rows: event.nativeEvent.rows,
		};
		if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current);
		resizeTimerRef.current = setTimeout(() => {
			if (options === null || activeId === null || ownerId === null) return;
			void Effect.runPromise(
				resizeTerminal({
					connection: options,
					ptyId: activeId,
					ownerId,
					...sizeRef.current,
				}),
			).catch((cause) => setError(connectionErrorMessage(cause)));
		}, RESIZE_DEBOUNCE_MS);
	};

	const onOpenLink = (event: TerminalLinkEvent) => {
		const url = event.nativeEvent.url;
		Alert.alert("Open external link?", url, [
			{ text: "Cancel", style: "cancel" },
			{
				text: "Open",
				onPress: () => void Linking.openURL(url),
			},
		]);
	};

	const closeActive = () => {
		if (options === null || activeId === null || ownerId === null) return;
		Alert.alert(
			"Close terminal?",
			"This ends the remote shell. Leaving this screen keeps it running.",
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Close terminal",
					style: "destructive",
					onPress: () => {
						void Effect.runPromise(
							closeTerminal({
								connection: options,
								ptyId: activeId,
								ownerId,
							}),
						)
							.then(async () => {
								const rows = await refreshTerminals();
								setActiveId(
									rows.find((item) => item.status === "running")?.ptyId ?? null,
								);
							})
							.catch((cause) => setError(connectionErrorMessage(cause)));
					},
				},
			],
		);
	};

	return (
		<View className="flex-1 bg-black">
			<Stack.Screen
				options={{
					title: label,
					headerRight: () => (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Close terminal"
							onPress={closeActive}
							className="h-11 w-11 items-center justify-center"
						>
							<X size={20} color={colors.fg} />
						</Pressable>
					),
				}}
			/>
			<View className="border-b border-white/10 bg-black px-2 py-1">
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={{ gap: 6, alignItems: "center" }}
				>
					{terminals
						.filter((terminal) => terminal.status === "running")
						.map((terminal) => (
							<Pressable
								key={terminal.ptyId}
								accessibilityRole="tab"
								accessibilityState={{ selected: terminal.ptyId === activeId }}
								onPress={() => setActiveId(terminal.ptyId)}
								className={`min-h-11 justify-center rounded-lg px-3 ${
									terminal.ptyId === activeId ? "bg-white/15" : "bg-white/5"
								}`}
							>
								<Text
									className="font-mono text-xs text-white"
									numberOfLines={1}
								>
									{terminal.label ?? "Shell"}
								</Text>
							</Pressable>
						))}
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="New terminal"
						onPress={() => void openNewTerminal()}
						className="h-11 w-11 items-center justify-center rounded-lg bg-white/5"
					>
						<Plus size={18} color="#ffffff" />
					</Pressable>
				</ScrollView>
			</View>
			<View className="flex-row items-center gap-2 bg-black px-3 py-1">
				<View
					className={`h-2 w-2 rounded-full ${
						status === "running"
							? "bg-green-500"
							: status === "failed" || status === "exited"
								? "bg-red-500"
								: "bg-amber-400"
					}`}
				/>
				<Text className="font-mono text-[11px] text-white/60">{status}</Text>
				{error === null ? null : (
					<Text
						numberOfLines={1}
						className="min-w-0 flex-1 font-sans text-[11px] text-red-400"
					>
						{error}
					</Text>
				)}
			</View>
			{activeId === null ? (
				<View className="flex-1 items-center justify-center px-8">
					<Text className="text-center font-sans text-sm text-white/60">
						No live terminal is selected.
					</Text>
				</View>
			) : (
				<ZuseMobileTerminalView
					key={activeId}
					style={{ flex: 1, backgroundColor: "#000000" }}
					feed={feed}
					fontSize={fontSize}
					focusNonce={focusNonce}
					controlNonce={controlNonce}
					useMetal
					onInput={onInput}
					onResize={onResize}
					onOpenLink={onOpenLink}
				/>
			)}
			<ScrollView
				horizontal
				keyboardShouldPersistTaps="always"
				showsHorizontalScrollIndicator={false}
				className="max-h-14 border-t border-white/10 bg-black"
				contentContainerStyle={{
					alignItems: "center",
					gap: 4,
					paddingHorizontal: 6,
					paddingBottom: Math.max(4, insets.bottom),
				}}
			>
				<AccessoryButton
					label="Ctrl"
					onPress={() => setControlNonce((value) => value + 1)}
				/>
				{accessoryKeys.map((key) => (
					<AccessoryButton
						key={key.label}
						label={key.label}
						onPress={() => inputPumpRef.current?.enqueue(key.data)}
					/>
				))}
				<AccessoryButton
					label="Smaller text"
					icon={<Minus size={15} color="#ffffff" />}
					onPress={() => setFontSize((value) => Math.max(9, value - 1))}
				/>
				<AccessoryButton
					label="Larger text"
					icon={<Plus size={15} color="#ffffff" />}
					onPress={() => setFontSize((value) => Math.min(24, value + 1))}
				/>
			</ScrollView>
		</View>
	);
}

function AccessoryButton({
	label,
	icon,
	onPress,
}: {
	label: string;
	icon?: React.ReactNode;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			onPress={onPress}
			className="h-11 min-w-11 items-center justify-center rounded-lg bg-white/10 px-3 active:bg-white/20"
		>
			{icon ?? <Text className="font-mono text-xs text-white">{label}</Text>}
		</Pressable>
	);
}
