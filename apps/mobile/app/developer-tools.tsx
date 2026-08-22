import { useAtomValue } from "@effect/atom-react";
import type { PtySummary } from "@zuse/contracts";
import { Effect } from "effect";
import { Stack } from "expo-router";
import { Mic2, TerminalSquare } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
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
import { getOrCreateDeviceId } from "~/lib/device-identity";
import { getVoiceCapabilities, listOwnedTerminals } from "~/rpc/actions";
import { connectionsAtom } from "~/store/connections";

type TerminalRow = {
	readonly connectionLabel: string;
	readonly terminal: PtySummary;
};

export default function DeveloperToolsScreen() {
	const connections = useAtomValue(connectionsAtom);
	const [terminals, setTerminals] = useState<readonly TerminalRow[]>([]);
	const [voiceStatus, setVoiceStatus] = useState("Not checked");
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		setLoading(true);
		const ownerId = await getOrCreateDeviceId();
		const results = await Promise.all(
			connections.map(async (record) => {
				const connection = optionsForConnection(record.key, connections);
				if (connection === null)
					return { terminals: [] as TerminalRow[], voice: null };
				let terminals: TerminalRow[] = [];
				if (connectionSupports(record, "mobile-terminal-v1")) {
					const owned = await Effect.runPromise(
						listOwnedTerminals({ connection, ownerId }),
					).catch(() => []);
					terminals = owned.map((terminal) => ({
						connectionLabel: record.label,
						terminal,
					}));
				}
				if (connectionSupports(record, "voice-account-transcription-v1")) {
					const capability = await Effect.runPromise(
						getVoiceCapabilities({ connection }),
					).catch(() => null);
					if (capability !== null) {
						return {
							terminals,
							voice: {
								available: capability.available,
								label: capability.available
									? `Ready on ${record.label}`
									: `No compatible signed-in account on ${record.label}`,
							},
						};
					}
				}
				return { terminals, voice: null };
			}),
		);
		setTerminals(results.flatMap((result) => result.terminals));
		const voiceResults = results.flatMap((result) =>
			result.voice === null ? [] : [result.voice],
		);
		setVoiceStatus(
			voiceResults.find((result) => result.available)?.label ??
				voiceResults[0]?.label ??
				"Not supported by connected environments",
		);
		setLoading(false);
	}, [connections]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

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
					{terminals.map(({ connectionLabel, terminal }) => (
						<ListRow
							key={terminal.ptyId}
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
