import { useAtomValue } from "@effect/atom-react";
import { cloudChatPlaceholder } from "@zuse/client-runtime/cloud-catalog";
import { type Chat, type CloudChatSummary, FolderId } from "@zuse/contracts";
import { Effect } from "effect";
import { Stack } from "expo-router";
import { ArchiveRestore, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Pressable,
	RefreshControl,
	ScrollView,
	Text,
	View,
} from "react-native";

import { connectionErrorMessage } from "~/lib/connection-error-message";
import { optionsForConnection } from "~/lib/connection-params";
import {
	deleteArchivedChat,
	listArchivedChats,
	previewArchivedChat,
	unarchiveChat,
} from "~/rpc/actions";
import { cloudControlClient } from "~/rpc/api-client";
import { authAccountAtom } from "~/store/auth";
import { refreshCloudCatalog } from "~/store/cloud-catalog";
import { allConnectionsAtom as connectionsAtom } from "~/store/connections";
import { bundlesByConnectionAtom } from "~/store/sessions";
import { colors } from "~/theme";

type ArchivedRow = {
	readonly connectionKey: string;
	readonly projectId: FolderId;
	readonly projectName: string;
	readonly chat: Chat;
	readonly cloudWorkspaceId?: string;
};

const archivedCloudRow = (row: CloudChatSummary): ArchivedRow => {
	const projectId = FolderId.make(`cloud:${row.projectId}`);
	return {
		connectionKey: `cloud:${row.workspaceId}`,
		projectId,
		projectName: row.repositoryDisplayName,
		chat: cloudChatPlaceholder(row, projectId),
		cloudWorkspaceId: row.workspaceId,
	};
};

export default function ArchivesScreen() {
	const connections = useAtomValue(connectionsAtom);
	const account = useAtomValue(authAccountAtom);
	const accountRef = useRef(account?.id);
	accountRef.current = account?.id;
	const bundles = useAtomValue(bundlesByConnectionAtom);
	const [rows, setRows] = useState<readonly ArchivedRow[]>([]);
	const [cloudRows, setCloudRows] = useState<readonly ArchivedRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			if (account !== null) {
				const result = await Effect.runPromise(
					cloudControlClient["cloud.chats.list"]({ scope: "archived" }),
				);
				if (accountRef.current !== account.id) return;
				setCloudRows(result.chats.map(archivedCloudRow));
			} else setCloudRows([]);
			const loaded = await Promise.all(
				Object.entries(bundles).flatMap(([connectionKey, projectBundles]) => {
					const connection = optionsForConnection(connectionKey, connections);
					if (connection === null || connection.cloudWorkspaceId !== undefined)
						return [];
					return projectBundles.map(async (bundle) => {
						const chats = await Effect.runPromise(
							listArchivedChats({
								connection,
								projectId: bundle.project.id,
							}),
						);
						return chats.map(
							(chat): ArchivedRow => ({
								connectionKey,
								projectId: bundle.project.id,
								projectName: bundle.project.name,
								chat,
							}),
						);
					});
				}),
			);
			setRows(
				loaded
					.flat()
					.sort(
						(a, b) =>
							(b.chat.archivedAt?.getTime() ?? 0) -
							(a.chat.archivedAt?.getTime() ?? 0),
					),
			);
		} catch (cause) {
			setError(connectionErrorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, [account, bundles, connections]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const restore = async (row: ArchivedRow) => {
		const connection = optionsForConnection(row.connectionKey, connections);
		if (connection === null && row.cloudWorkspaceId === undefined) return;
		setBusyId(row.chat.id);
		try {
			if (row.cloudWorkspaceId !== undefined)
				await Effect.runPromise(
					cloudControlClient["cloud.workspaces.unarchive"]({
						workspaceId: row.cloudWorkspaceId,
					}),
				);
			else if (connection !== null)
				await Effect.runPromise(
					unarchiveChat({ connection, chatId: row.chat.id }),
				);
			if (row.cloudWorkspaceId !== undefined) {
				setCloudRows((current) =>
					current.filter((candidate) => candidate.chat.id !== row.chat.id),
				);
				await refreshCloudCatalog();
			}
			setRows((current) =>
				current.filter((candidate) => candidate.chat.id !== row.chat.id),
			);
		} catch (cause) {
			Alert.alert("Could not unarchive", connectionErrorMessage(cause));
		} finally {
			setBusyId(null);
		}
	};

	const confirmDelete = (row: ArchivedRow) => {
		const connection = optionsForConnection(row.connectionKey, connections);
		if (connection === null && row.cloudWorkspaceId === undefined) return;
		Alert.prompt(
			"Delete permanently?",
			`This permanently deletes “${row.chat.title}” and its sessions. Type DELETE to continue.`,
			(value) => {
				if (value !== "DELETE") return;
				setBusyId(row.chat.id);
				const deletion =
					row.cloudWorkspaceId !== undefined
						? Effect.runPromise(
								cloudControlClient["cloud.workspaces.delete"]({
									workspaceId: row.cloudWorkspaceId,
								}),
							)
						: connection === null
							? Promise.reject(new Error("Connection unavailable"))
							: Effect.runPromise(
									deleteArchivedChat({ connection, chatId: row.chat.id }),
								);
				void deletion
					.then(() =>
						setCloudRows((current) =>
							current.filter((candidate) => candidate.chat.id !== row.chat.id),
						),
					)
					.then(() =>
						setRows((current) =>
							current.filter((candidate) => candidate.chat.id !== row.chat.id),
						),
					)
					.catch((cause) =>
						Alert.alert("Could not delete", connectionErrorMessage(cause)),
					)
					.finally(() => setBusyId(null));
			},
			"plain-text",
		);
	};

	const showPreview = async (row: ArchivedRow) => {
		if (row.cloudWorkspaceId !== undefined) {
			Alert.alert(row.chat.title, `Cloud workspace · ${row.projectName}`, [
				{ text: "Cancel", style: "cancel" },
				{ text: "Unarchive", onPress: () => void restore(row) },
				{
					text: "Delete",
					style: "destructive",
					onPress: () => confirmDelete(row),
				},
			]);
			return;
		}
		const connection = optionsForConnection(row.connectionKey, connections);
		if (connection === null) return;
		try {
			const preview = await Effect.runPromise(
				previewArchivedChat({ connection, chatId: row.chat.id }),
			);
			Alert.alert(
				row.chat.title,
				`${preview.sessions.length} ${preview.sessions.length === 1 ? "session" : "sessions"}\nProject: ${row.projectName}`,
				[
					{ text: "Cancel", style: "cancel" },
					{ text: "Unarchive", onPress: () => void restore(row) },
					{
						text: "Delete",
						style: "destructive",
						onPress: () => confirmDelete(row),
					},
				],
			);
		} catch (cause) {
			Alert.alert("Could not load preview", connectionErrorMessage(cause));
		}
	};

	return (
		<>
			<Stack.Screen options={{ title: "Archived chats" }} />
			<ScrollView
				className="flex-1"
				contentInsetAdjustmentBehavior="automatic"
				refreshControl={
					<RefreshControl
						refreshing={loading}
						onRefresh={() => void refresh()}
					/>
				}
				contentContainerClassName="gap-3 px-5 pb-12 pt-4"
			>
				{loading && rows.length === 0 ? <ActivityIndicator /> : null}
				{error === null ? null : (
					<Text selectable className="text-danger">
						{error}
					</Text>
				)}
				{!loading && rows.length === 0 && cloudRows.length === 0 ? (
					<Text className="py-12 text-center font-sans text-muted-foreground">
						No archived chats
					</Text>
				) : null}
				{[...cloudRows, ...rows].map((row) => (
					<Pressable
						key={`${row.connectionKey}:${row.chat.id}`}
						disabled={busyId !== null}
						accessibilityRole="button"
						accessibilityLabel={`Preview archived chat ${row.chat.title}`}
						onPress={() => void showPreview(row)}
						className="min-h-16 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 active:opacity-60"
					>
						<View className="min-w-0 flex-1">
							<Text
								numberOfLines={1}
								className="font-sans-medium text-[16px] text-foreground"
							>
								{row.chat.title}
							</Text>
							<Text
								numberOfLines={1}
								className="font-sans text-[13px] text-muted-foreground"
							>
								{row.projectName}
							</Text>
						</View>
						{busyId === row.chat.id ? (
							<ActivityIndicator />
						) : (
							<>
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={`Unarchive ${row.chat.title}`}
									hitSlop={8}
									className="h-11 w-11 items-center justify-center"
									onPress={() => void restore(row)}
								>
									<ArchiveRestore size={19} color={colors.fg} />
								</Pressable>
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={`Delete ${row.chat.title} permanently`}
									hitSlop={8}
									className="h-11 w-11 items-center justify-center"
									onPress={() => confirmDelete(row)}
								>
									<Trash2 size={19} color={colors.danger} />
								</Pressable>
							</>
						)}
					</Pressable>
				))}
			</ScrollView>
		</>
	);
}
