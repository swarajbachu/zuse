import { useAtomValue } from "@effect/atom-react";
import type { TerminalRef } from "@zuse/client-runtime/resource-ref";
import type { TerminalCatalog } from "@zuse/client-runtime/terminal-catalog";
import { createTerminalInputPump } from "@zuse/client-runtime/terminal-input-pump";
import { type PtyId, PtyOpenToken, type PtySummary } from "@zuse/contracts";
import { Effect } from "effect";
import * as ExpoCrypto from "expo-crypto";
import * as Linking from "expo-linking";
import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { Minus, Pencil, Plus, RotateCcw, X } from "lucide-react-native";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { getOrCreateDeviceId } from "~/lib/device-identity";
import { mobileReleaseFeatures } from "~/lib/release-features";
import {
	makeTerminalFeedChannel,
	makeTerminalFeedLeaseCleanup,
	type TerminalFeed,
	terminalFeedValue,
} from "~/lib/terminal-feed-channel";
import {
	findTerminalForOpenToken,
	terminalOpenFailureMessage,
} from "~/lib/terminal-open-reconciliation";
import {
	makeTerminalCatalogRefreshQueue,
	makeTerminalRouteFence,
	mobileTerminalOwnerId,
	terminalRouteIdentity,
} from "~/lib/terminal-route-fence";
import {
	type TerminalInputEvent,
	type TerminalLinkEvent,
	type TerminalResizeEvent,
	ZuseMobileTerminalView,
} from "~/native/mobile-terminal";
import {
	listOwnedTerminals,
	openMobileTerminal,
	renameOwnedTerminal,
	restartOwnedTerminal,
} from "~/rpc/actions";
import { allConnectionsAtom as connectionsAtom } from "~/store/connections";
import {
	dispatchMobileTerminalClose,
	dispatchMobileTerminalInput,
	dispatchMobileTerminalResize,
	mobileClientBus,
	restartMobileTerminalResource,
	retainMobileTerminalResource,
} from "~/store/mobile-client-bus";
import { colors } from "~/theme";

type RuntimeStatus =
	| "connecting"
	| "running"
	| "reconnecting"
	| "exited"
	| "failed";

const INPUT_ACK_STALL_WARNING_MS = 3_000;
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
	return mobileReleaseFeatures.terminal ? (
		<MobileTerminalContent />
	) : (
		<Redirect href="/" />
	);
}

function MobileTerminalContent() {
	const params = useLocalSearchParams<{
		conn?: string | string[];
		sessionId?: string | string[];
		cwd?: string | string[];
		label?: string | string[];
	}>();
	const connKey = normalizeConnParam(params.conn);
	const sessionKey = paramValue(params.sessionId);
	const cwd = paramValue(params.cwd);
	const label = paramValue(params.label) || "Terminal";
	const connections = useAtomValue(connectionsAtom);
	const options = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const insets = useSafeAreaInsets();
	const [deviceId, setDeviceId] = useState<string | null>(null);
	const ownerId = useMemo(
		() =>
			deviceId === null || sessionKey.length === 0
				? null
				: mobileTerminalOwnerId(deviceId, sessionKey),
		[deviceId, sessionKey],
	);
	const routeFenceRef = useRef(makeTerminalRouteFence());
	const routeIdentity = terminalRouteIdentity(
		connKey,
		sessionKey,
		cwd,
		ownerId,
	);
	const [terminals, setTerminals] = useState<readonly PtySummary[]>([]);
	const [catalogPolicy, setCatalogPolicy] = useState<
		Readonly<{
			routeIdentity: string;
			liveLimit: number | null;
		}>
	>({ routeIdentity, liveLimit: null });
	const liveLimit =
		catalogPolicy.routeIdentity === routeIdentity
			? catalogPolicy.liveLimit
			: null;
	const [activeSelection, setActiveSelection] = useState<Readonly<{
		routeIdentity: string;
		ptyId: PtyId;
	}> | null>(null);
	const activeId =
		activeSelection?.routeIdentity === routeIdentity
			? activeSelection.ptyId
			: null;
	const [status, setStatus] = useState<RuntimeStatus>("connecting");
	const [error, setError] = useState<string | null>(null);
	const [terminalFeed, setTerminalFeed] = useState<TerminalFeed | null>(null);
	const [fontSize, setFontSize] = useState(12);
	const [focusNonce, setFocusNonce] = useState(1);
	const [controlNonce, setControlNonce] = useState(0);
	const feedChannelRef = useRef(makeTerminalFeedChannel());
	const catalogRefreshQueue = useRef(
		makeTerminalCatalogRefreshQueue<TerminalCatalog>(),
	).current;
	const terminalResourceCleanupRef = useRef<(() => void) | null>(null);
	// Authority changes only after React commits this route/selection. An aborted
	// concurrent render must not revoke the still-mounted terminal's output sink.
	useLayoutEffect(() => {
		routeFenceRef.current.commit(routeIdentity);
		feedChannelRef.current.commitSelection(activeId);
		return () => {
			// Stop the old resource driver before rejecting any feed it is awaiting.
			// Its failure handler then sees a revoked lease and cannot mark the cached
			// resource failed during the layout-to-passive cleanup window.
			const cleanup = terminalResourceCleanupRef.current;
			terminalResourceCleanupRef.current = null;
			cleanup?.();
			feedChannelRef.current.commitSelection(null);
		};
	}, [activeId, routeIdentity]);
	const feed = terminalFeedValue(terminalFeed, activeId);
	useLayoutEffect(() => {
		const remaining = feedChannelRef.current.acknowledge(terminalFeed);
		if (
			remaining !== null &&
			(feed === undefined || remaining !== terminalFeed)
		) {
			setTerminalFeed(remaining);
		}
	}, [feed, terminalFeed]);
	const terminalRef = useRef<TerminalRef | null>(null);
	const phaseRef = useRef<RuntimeStatus>("connecting");
	const inputPumpRef = useRef<ReturnType<
		typeof createTerminalInputPump
	> | null>(null);
	const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const sizeRef = useRef({ cols: 80, rows: 24 });
	const terminalsRef = useRef<
		Readonly<{
			routeIdentity: string;
			rows: readonly PtySummary[];
			liveLimit: number | null;
		}>
	>({ routeIdentity, rows: [], liveLimit: null });
	const pendingOpenTokenRef = useRef<Readonly<{
		routeIdentity: string;
		token: PtyOpenToken;
	}> | null>(null);
	const openPromiseRef = useRef<Readonly<{
		routeIdentity: string;
		promise: Promise<void>;
	}> | null>(null);
	const selectActiveId = useCallback(
		(ptyId: PtyId | null) =>
			setActiveSelection(ptyId === null ? null : { routeIdentity, ptyId }),
		[routeIdentity],
	);

	useEffect(
		() => () => {
			if (resizeTimerRef.current !== null) {
				clearTimeout(resizeTimerRef.current);
			}
		},
		[],
	);

	useEffect(() => {
		void getOrCreateDeviceId()
			.then(setDeviceId)
			.catch((cause) => {
				setError(connectionErrorMessage(cause));
				setStatus("failed");
			});
	}, []);

	const refreshTerminals = useCallback(async () => {
		if (options === null || ownerId === null) return [];
		const catalog = await catalogRefreshQueue.run(routeIdentity, () =>
			Effect.runPromise(listOwnedTerminals({ connection: options, ownerId })),
		);
		if (!routeFenceRef.current.isCurrent(routeIdentity)) return [];
		terminalsRef.current = {
			routeIdentity,
			rows: catalog.terminals,
			liveLimit: catalog.liveLimit,
		};
		setTerminals(catalog.terminals);
		setCatalogPolicy({
			routeIdentity,
			liveLimit: catalog.liveLimit,
		});
		return catalog.terminals;
	}, [catalogRefreshQueue, options, ownerId, routeIdentity]);

	const openNewTerminal = useCallback((): Promise<void> => {
		if (options === null || ownerId === null || cwd.length === 0) {
			return Promise.resolve();
		}
		const currentOpen = openPromiseRef.current;
		if (currentOpen?.routeIdentity === routeIdentity) {
			return currentOpen.promise;
		}
		const currentRows =
			terminalsRef.current.routeIdentity === routeIdentity
				? terminalsRef.current.rows
				: [];
		const currentLiveLimit =
			terminalsRef.current.routeIdentity === routeIdentity
				? terminalsRef.current.liveLimit
				: null;
		if (
			currentLiveLimit !== null &&
			currentRows.filter((terminal) => terminal.status === "running").length >=
				currentLiveLimit
		) {
			setStatus("failed");
			setError(
				`Terminal limit reached (${currentLiveLimit}). Close a terminal, then retry.`,
			);
			return Promise.resolve();
		}

		const openToken =
			pendingOpenTokenRef.current?.routeIdentity === routeIdentity
				? pendingOpenTokenRef.current.token
				: PtyOpenToken.make(ExpoCrypto.randomUUID());
		pendingOpenTokenRef.current = {
			routeIdentity,
			token: openToken,
		};
		setError(null);
		setStatus("connecting");
		const operation = (async () => {
			try {
				const result = await Effect.runPromise(
					openMobileTerminal({
						connection: options,
						ownerId,
						openToken,
						cwd,
						label,
						cols: sizeRef.current.cols,
						rows: sizeRef.current.rows,
					}),
				);
				const rows = await refreshTerminals();
				if (!routeFenceRef.current.isCurrent(routeIdentity)) return;
				selectActiveId(
					findTerminalForOpenToken(rows, openToken)?.ptyId ?? result.ptyId,
				);
				pendingOpenTokenRef.current = null;
			} catch (cause) {
				let recovered: PtySummary | undefined;
				try {
					recovered = findTerminalForOpenToken(
						await refreshTerminals(),
						openToken,
					);
				} catch {
					// Preserve the original open failure when catalog recovery is offline.
				}
				if (!routeFenceRef.current.isCurrent(routeIdentity)) return;
				if (recovered !== undefined) {
					pendingOpenTokenRef.current = null;
					selectActiveId(recovered.ptyId);
					setError(null);
					setStatus(recovered.status === "running" ? "connecting" : "exited");
					return;
				}
				setStatus("failed");
				setError(
					terminalOpenFailureMessage(cause, connectionErrorMessage(cause)),
				);
			}
		})();
		let tracked: Promise<void>;
		tracked = operation.finally(() => {
			if (openPromiseRef.current?.promise === tracked) {
				openPromiseRef.current = null;
			}
		});
		openPromiseRef.current = { routeIdentity, promise: tracked };
		return tracked;
	}, [
		cwd,
		label,
		options,
		ownerId,
		refreshTerminals,
		routeIdentity,
		selectActiveId,
	]);

	useEffect(() => {
		if (pendingOpenTokenRef.current?.routeIdentity !== routeIdentity) {
			pendingOpenTokenRef.current = null;
		}
		terminalsRef.current = {
			routeIdentity,
			rows: [],
			liveLimit: null,
		};
		setTerminals([]);
		setCatalogPolicy({ routeIdentity, liveLimit: null });
		setError(null);
		setStatus("connecting");
		if (resizeTimerRef.current !== null) {
			clearTimeout(resizeTimerRef.current);
			resizeTimerRef.current = null;
		}
	}, [routeIdentity]);

	useEffect(() => {
		if (options === null || ownerId === null) return;
		let active = true;
		void refreshTerminals()
			.then((rows) => {
				if (!active || !routeFenceRef.current.isCurrent(routeIdentity)) return;
				const existing = rows.find(
					(item) => item.status === "running" && item.cwd === cwd,
				);
				if (existing !== undefined) selectActiveId(existing.ptyId);
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
	}, [
		cwd,
		openNewTerminal,
		options,
		ownerId,
		refreshTerminals,
		routeIdentity,
		selectActiveId,
	]);

	useEffect(() => {
		const previousCleanup = terminalResourceCleanupRef.current;
		terminalResourceCleanupRef.current = null;
		previousCleanup?.();
		if (options === null || activeId === null || ownerId === null) return;
		phaseRef.current = "connecting";
		setStatus("connecting");
		setError(null);
		const publishFeed = async (bytes: string): Promise<void> => {
			const publication = feedChannelRef.current.append(activeId, bytes);
			setTerminalFeed(publication.feed);
			await publication.committed;
		};
		const sink = {
			reset: async () => {
				// RIS clears parser, screen, cursor, and scrollback before bytes from
				// the replacement process are accepted by the resource driver.
				await publishFeed("\u001bc");
			},
			write: publishFeed,
			exited: async (exitCode: number | null) => {
				await publishFeed(
					`\r\n\u001b[38;5;244m[process exited${
						exitCode === null ? "" : ` with code ${exitCode}`
					}]\u001b[0m\r\n`,
				);
				void refreshTerminals();
			},
		};
		const retained = retainMobileTerminalResource({
			connKey,
			connection: options,
			terminalId: activeId,
			ownerId,
			sink,
		});
		terminalRef.current = retained.ref;
		const publish = () => {
			const view = mobileClientBus().snapshot(retained.key);
			const phase =
				view.data?.phase ??
				(view.connection === "reconnecting" ? "reconnecting" : "connecting");
			if (phaseRef.current !== "running" && phase === "running") {
				setFocusNonce((value) => value + 1);
			}
			phaseRef.current = phase;
			setStatus(phase);
			setError(view.data?.failure?.message ?? null);
		};
		const unsubscribe = mobileClientBus().subscribe(retained.key, publish);
		publish();
		const inputPump = createTerminalInputPump({
			stallWarningMs: INPUT_ACK_STALL_WARNING_MS,
			write: (data) => dispatchMobileTerminalInput(retained.ref, ownerId, data),
			onFailure: () => {
				setStatus("failed");
				setError("Terminal input could not be delivered.");
			},
			onStall: (elapsedMs) => {
				console.warn("[zuse:terminal] input.acknowledgement_delayed", {
					elapsedMs,
				});
			},
		});
		inputPumpRef.current = inputPump;
		const cleanup = makeTerminalFeedLeaseCleanup({
			channel: feedChannelRef.current,
			terminalId: activeId,
			stopResource: () => {
				if (terminalRef.current === retained.ref) terminalRef.current = null;
				inputPump.dispose();
				if (inputPumpRef.current === inputPump) inputPumpRef.current = null;
				unsubscribe();
				retained.lease.release();
			},
			clearFeed: () => setTerminalFeed(null),
		});
		terminalResourceCleanupRef.current = cleanup;
		return () => {
			if (terminalResourceCleanupRef.current === cleanup) {
				terminalResourceCleanupRef.current = null;
			}
			cleanup();
		};
	}, [activeId, connKey, options, ownerId, refreshTerminals]);

	const onInput = (event: TerminalInputEvent) => {
		inputPumpRef.current?.enqueue(event.nativeEvent.data);
	};

	const onResize = (event: TerminalResizeEvent) => {
		const identity = routeIdentity;
		sizeRef.current = {
			cols: event.nativeEvent.cols,
			rows: event.nativeEvent.rows,
		};
		if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current);
		resizeTimerRef.current = setTimeout(() => {
			if (terminalRef.current === null || ownerId === null) return;
			void dispatchMobileTerminalResize(
				terminalRef.current,
				ownerId,
				sizeRef.current.cols,
				sizeRef.current.rows,
			).catch((cause) => {
				if (routeFenceRef.current.isCurrent(identity)) {
					setError(connectionErrorMessage(cause));
				}
			});
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
		const ref = terminalRef.current;
		if (ref === null || ownerId === null) return;
		const identity = routeIdentity;
		Alert.alert(
			"Close terminal?",
			"This ends the remote shell. Leaving this screen keeps it running.",
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Close terminal",
					style: "destructive",
					onPress: () => {
						void dispatchMobileTerminalClose(ref, ownerId)
							.then(async () => {
								const rows = await refreshTerminals();
								if (!routeFenceRef.current.isCurrent(identity)) return;
								selectActiveId(
									rows.find((item) => item.status === "running")?.ptyId ?? null,
								);
							})
							.catch((cause) => {
								if (routeFenceRef.current.isCurrent(identity)) {
									setError(connectionErrorMessage(cause));
								}
							});
					},
				},
			],
		);
	};

	const renameActive = () => {
		if (activeId === null || options === null || ownerId === null) return;
		const identity = routeIdentity;
		const currentLabel =
			terminals.find((terminal) => terminal.ptyId === activeId)?.label ?? "";
		Alert.prompt(
			"Rename terminal",
			undefined,
			(value) => {
				const nextLabel = value?.trim() || null;
				void Effect.runPromise(
					renameOwnedTerminal({
						connKey,
						connection: options,
						ownerId,
						ptyId: activeId,
						label: nextLabel,
					}),
				)
					.then(() => refreshTerminals())
					.catch(async (cause) => {
						let recovered = false;
						try {
							const rows = await refreshTerminals();
							recovered = rows.some(
								(terminal) =>
									terminal.ptyId === activeId && terminal.label === nextLabel,
							);
						} catch {
							// Keep the rename failure when catalog recovery is unavailable.
						}
						if (!routeFenceRef.current.isCurrent(identity) || recovered) return;
						setError(connectionErrorMessage(cause));
					});
			},
			"plain-text",
			currentLabel,
		);
	};

	const restartActive = () => {
		if (activeId === null || options === null || ownerId === null) return;
		const identity = routeIdentity;
		const previousEpoch = terminals.find(
			(terminal) => terminal.ptyId === activeId,
		)?.processEpoch;
		if (previousEpoch === undefined) {
			setStatus("failed");
			setError("Terminal process state is unavailable. Refresh, then retry.");
			return;
		}
		setStatus("connecting");
		setError(null);
		void Effect.runPromise(
			restartOwnedTerminal({
				connKey,
				connection: options,
				ownerId,
				ptyId: activeId,
				expectedProcessEpoch: previousEpoch,
			}),
		)
			.then(async () => {
				await refreshTerminals();
				if (!routeFenceRef.current.isCurrent(identity)) return;
				selectActiveId(activeId);
				setStatus("connecting");
			})
			.catch(async (cause) => {
				let recovered = false;
				try {
					const rows = await refreshTerminals();
					const summary = rows.find((terminal) => terminal.ptyId === activeId);
					recovered =
						summary !== undefined &&
						previousEpoch !== undefined &&
						summary.processEpoch !== previousEpoch;
				} catch {
					// Keep the restart failure when catalog recovery is unavailable.
				}
				if (!routeFenceRef.current.isCurrent(identity)) return;
				if (recovered) {
					const ref = terminalRef.current;
					if (ref !== null) restartMobileTerminalResource(ref);
					selectActiveId(activeId);
					setStatus("connecting");
					setError(null);
					return;
				}
				setStatus("failed");
				setError(connectionErrorMessage(cause));
			});
	};

	const atTerminalLimit =
		liveLimit !== null &&
		terminals.filter((terminal) => terminal.status === "running").length >=
			liveLimit;

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
								onPress={() => selectActiveId(terminal.ptyId)}
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
						accessibilityHint={
							atTerminalLimit
								? "Close a terminal before opening another."
								: undefined
						}
						accessibilityState={{ disabled: atTerminalLimit }}
						onPress={() => void openNewTerminal()}
						className={`h-11 w-11 items-center justify-center rounded-lg bg-white/5 ${
							atTerminalLimit ? "opacity-40" : ""
						}`}
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
				{activeId === null ? null : (
					<>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Rename terminal"
							hitSlop={8}
							onPress={renameActive}
							className="h-7 w-7 items-center justify-center rounded bg-white/5"
						>
							<Pencil size={13} color="#ffffff" />
						</Pressable>
						{status === "exited" || status === "failed" ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Restart terminal"
								hitSlop={8}
								onPress={restartActive}
								className="h-7 flex-row items-center gap-1 rounded bg-white/10 px-2"
							>
								<RotateCcw size={12} color="#ffffff" />
								<Text className="font-sans text-[11px] text-white">
									Restart
								</Text>
							</Pressable>
						) : null}
					</>
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
