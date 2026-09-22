import { useAtomValue } from "@effect/atom-react";
import type { PtySummary } from "@zuse/contracts";
import { Effect } from "effect";
import { Redirect, Stack } from "expo-router";
import { Mic2, TerminalSquare } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	RefreshControl,
	ScrollView,
	Text,
	View,
} from "react-native";
import { ListRow, ListSection } from "~/components/ui/list";
import { optionsForConnection } from "~/lib/connection-params";
import { connectionSupports } from "~/lib/connection-records";
import {
	makeDeveloperToolsRefreshAuthority,
	runBoundedDeveloperToolTasks,
	uniqueDeveloperTerminalTargets,
} from "~/lib/developer-tools-refresh";
import { getOrCreateDeviceId } from "~/lib/device-identity";
import { mobileReleaseFeatures } from "~/lib/release-features";
import { mobileTerminalOwnerId } from "~/lib/terminal-route-fence";
import { getVoiceCapabilities, listOwnedTerminals } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import { connectionsAtom } from "~/store/connections";
import { bundlesByConnectionAtom } from "~/store/sessions";

type TerminalRow = {
	readonly key: string;
	readonly connectionLabel: string;
	readonly terminal: PtySummary;
};

type TerminalTarget = {
	readonly connectionKey: string;
	readonly connectionLabel: string;
	readonly connection: WsProtocolOptions;
	readonly ownerId: ReturnType<typeof mobileTerminalOwnerId>;
};

type DeveloperToolResult =
	| { readonly _tag: "terminals"; readonly terminals: readonly TerminalRow[] }
	| {
			readonly _tag: "voice";
			readonly voice: {
				readonly available: boolean;
				readonly label: string;
			} | null;
	  };

export default function DeveloperToolsScreen() {
	return mobileReleaseFeatures.terminal || mobileReleaseFeatures.voice ? (
		<DeveloperToolsContent />
	) : (
		<Redirect href="/" />
	);
}

function DeveloperToolsContent() {
	const connections = useAtomValue(connectionsAtom);
	const bundlesByConnection = useAtomValue(bundlesByConnectionAtom);
	const [terminals, setTerminals] = useState<readonly TerminalRow[]>([]);
	const [voiceStatus, setVoiceStatus] = useState("Not checked");
	const [loading, setLoading] = useState(true);
	const refreshAuthority = useRef(makeDeveloperToolsRefreshAuthority()).current;

	const refresh = useCallback(async () => {
		const refreshToken = refreshAuthority.begin();
		setLoading(true);
		try {
			const deviceId = await getOrCreateDeviceId();
			const resolvedByKey = new Map<
				string,
				{
					readonly record: (typeof connections)[number];
					readonly connection: WsProtocolOptions;
				}
			>();
			for (const record of connections) {
				const connection = optionsForConnection(record.key, connections);
				if (connection !== null && !resolvedByKey.has(record.key)) {
					resolvedByKey.set(record.key, { record, connection });
				}
			}
			const resolvedConnections = [...resolvedByKey.values()];
			const terminalTargets = uniqueDeveloperTerminalTargets(
				resolvedConnections.flatMap<TerminalTarget>(
					({ record, connection }) => {
						if (!connectionSupports(record, "mobile-terminal-v1")) return [];
						const sessions = (bundlesByConnection[record.key] ?? []).flatMap(
							(bundle) => bundle.sessions,
						);
						return sessions.map((session) => ({
							connectionKey: record.key,
							connectionLabel: record.label,
							connection,
							ownerId: mobileTerminalOwnerId(deviceId, session.id),
						}));
					},
				),
			);
			const tasks: Array<() => Promise<DeveloperToolResult>> =
				terminalTargets.map((target) => async () => {
					const catalog = await Effect.runPromise(
						listOwnedTerminals({
							connection: target.connection,
							ownerId: target.ownerId,
						}),
					).catch(() => ({ terminals: [], liveLimit: null }) as const);
					return {
						_tag: "terminals" as const,
						terminals: catalog.terminals.map((terminal) => ({
							key: JSON.stringify([target.connectionKey, terminal.ptyId]),
							connectionLabel: target.connectionLabel,
							terminal,
						})),
					};
				});
			for (const { record, connection } of resolvedConnections) {
				if (connectionSupports(record, "voice-account-transcription-v1")) {
					tasks.push(async () => {
						const capability = await Effect.runPromise(
							getVoiceCapabilities({ connection }),
						).catch(() => null);
						return {
							_tag: "voice" as const,
							voice:
								capability === null
									? null
									: {
											available: capability.available,
											label: capability.available
												? `Ready on ${record.label}`
												: `No compatible signed-in account on ${record.label}`,
										},
						};
					});
				}
			}
			const results = await runBoundedDeveloperToolTasks(tasks);
			if (!refreshAuthority.isCurrent(refreshToken)) return;
			setTerminals(
				results.flatMap((result) =>
					result._tag === "terminals" ? result.terminals : [],
				),
			);
			const voiceResults = results.flatMap((result) =>
				result._tag === "voice" && result.voice !== null ? [result.voice] : [],
			);
			setVoiceStatus(
				voiceResults.find((result) => result.available)?.label ??
					voiceResults[0]?.label ??
					"Not supported by connected environments",
			);
		} catch {
			if (!refreshAuthority.isCurrent(refreshToken)) return;
			setTerminals([]);
			setVoiceStatus("Could not refresh developer tools");
		} finally {
			if (refreshAuthority.isCurrent(refreshToken)) setLoading(false);
		}
	}, [bundlesByConnection, connections, refreshAuthority]);

	useEffect(() => {
		void refresh();
		return () => refreshAuthority.invalidate();
	}, [refresh, refreshAuthority]);

	return (
		<>
			<Stack.Screen options={{ title: "Developer tools" }} />
			<ScrollView
				className="flex-1"
				contentInsetAdjustmentBehavior="automatic"
				refreshControl={
					<RefreshControl
						refreshing={loading}
						onRefresh={() => void refresh()}
					/>
				}
				contentContainerClassName="gap-6 px-5 pb-12 pt-4"
			>
				<ListSection header="Voice readiness">
					<ListRow
						icon={Mic2}
						title="Account transcription"
						subtitle={voiceStatus}
						chevron={false}
					/>
				</ListSection>
				<ListSection
					header="Terminal sessions"
					footer="Leaving a terminal screen detaches it. Explicitly close a terminal from the terminal screen when it is no longer needed."
				>
					{loading && terminals.length === 0 ? (
						<View className="min-h-14 items-center justify-center">
							<ActivityIndicator />
						</View>
					) : null}
					{!loading && terminals.length === 0 ? (
						<View className="min-h-14 justify-center px-4">
							<Text className="font-sans text-[15px] text-muted-foreground">
								No live mobile terminals
							</Text>
						</View>
					) : null}
					{terminals.map(({ key, connectionLabel, terminal }) => (
						<ListRow
							key={key}
							icon={TerminalSquare}
							title={terminal.label ?? "Terminal"}
							subtitle={`${connectionLabel} · ${terminal.cwd}`}
							value={terminal.status}
							chevron={false}
						/>
					))}
				</ListSection>
			</ScrollView>
		</>
	);
}
