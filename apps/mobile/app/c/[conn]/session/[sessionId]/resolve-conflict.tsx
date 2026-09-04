import { useAtomValue } from "@effect/atom-react";
import type { FolderId, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { readGitReviewFileContents, resolveGitConflict } from "~/rpc/actions";
import { allConnectionsAtom as connectionsAtom } from "~/store/connections";
import { connectionBundlesAtom, selectSessionChat } from "~/store/sessions";
import { colors } from "~/theme";

const hasConflictMarkers = (value: string): boolean =>
	/(?:^|\n)(?:<{7}|={7}|>{7})(?: |\n|$)/.test(value);

export default function ResolveConflictScreen() {
	const params = useLocalSearchParams<{
		conn: string;
		sessionId: string;
		path: string;
		oldPath?: string;
	}>();
	const connKey = normalizeConnParam(params.conn);
	const sessionId = normalizeConnParam(params.sessionId) as SessionId;
	const path = normalizeConnParam(params.path);
	const oldPath = normalizeConnParam(params.oldPath);
	const connections = useAtomValue(connectionsAtom);
	const bundles = useAtomValue(connectionBundlesAtom(connKey));
	const detail = selectSessionChat(bundles, sessionId);
	const connection = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const folderId = detail?.project.id as FolderId | undefined;
	const worktreeId = detail?.session.worktreeId ?? null;
	const insets = useSafeAreaInsets();
	const [contents, setContents] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (connection === null || folderId === undefined || path.length === 0) {
			setLoading(false);
			return;
		}
		void Effect.runPromise(
			readGitReviewFileContents({
				connection,
				folderId,
				worktreeId,
				path,
				oldPath: oldPath || null,
			}),
		)
			.then((result) => setContents(result.newContent ?? ""))
			.catch((cause) => setError(connectionErrorMessage(cause)))
			.finally(() => setLoading(false));
	}, [connection, folderId, oldPath, path, worktreeId]);

	const save = async () => {
		if (
			connection === null ||
			folderId === undefined ||
			hasConflictMarkers(contents)
		)
			return;
		setSaving(true);
		setError(null);
		try {
			await Effect.runPromise(
				resolveGitConflict({
					connection,
					folderId,
					worktreeId,
					path,
					contents,
				}),
			);
			router.back();
		} catch (cause) {
			setError(connectionErrorMessage(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{
					title: path,
					headerRight: () => (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Save resolved file"
							disabled={saving || hasConflictMarkers(contents)}
							onPress={() => void save()}
							className="min-h-11 justify-center px-2 disabled:opacity-40"
						>
							<Text className="font-sans-medium text-sm text-accent">
								{saving ? "Saving…" : "Resolve"}
							</Text>
						</Pressable>
					),
				}}
			/>
			{loading ? (
				<View className="flex-1 items-center justify-center">
					<ActivityIndicator color={colors.accent} />
				</View>
			) : (
				<>
					<View className="border-b border-border bg-card px-4 py-3">
						<Text className="font-sans text-xs leading-5 text-muted-foreground">
							Edit the final file, remove every conflict marker, then tap
							Resolve. The server stages this path after validating it.
						</Text>
						{hasConflictMarkers(contents) ? (
							<Text className="pt-1 font-sans-medium text-xs text-warning">
								Conflict markers remain.
							</Text>
						) : null}
						{error === null ? null : (
							<Text selectable className="pt-1 font-sans text-xs text-danger">
								{error}
							</Text>
						)}
					</View>
					<TextInput
						accessibilityLabel={`Resolved contents for ${path}`}
						value={contents}
						onChangeText={setContents}
						multiline
						autoCapitalize="none"
						autoCorrect={false}
						className="flex-1 px-4 py-3 font-mono text-[12px] leading-5 text-foreground"
						style={{ paddingBottom: Math.max(16, insets.bottom) }}
						textAlignVertical="top"
					/>
				</>
			)}
		</View>
	);
}
