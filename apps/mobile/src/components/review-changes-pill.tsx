import type { FolderId, WorktreeId } from "@zuse/contracts";
import { Effect } from "effect";
import { GitCompareArrows } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { loadWorkspaceReview } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import { colors } from "~/theme";
import { GlassSurface } from "./ui/glass-surface";

export function ReviewChangesPill({
	connection,
	folderId,
	worktreeId,
	refreshKey,
	onPress,
}: {
	connection: WsProtocolOptions;
	folderId: FolderId;
	worktreeId?: WorktreeId | null;
	refreshKey: string;
	onPress: () => void;
}) {
	const [summary, setSummary] = useState<{
		files: number;
		additions: number;
		deletions: number;
	} | null>(null);

	useEffect(() => {
		void refreshKey;
		let active = true;
		void Effect.runPromise(
			loadWorkspaceReview({ connection, folderId, worktreeId }),
		)
			.then((review) => {
				if (!active) return;
				setSummary({
					files: review.files.length,
					additions: review.additions,
					deletions: review.deletions,
				});
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [connection, folderId, refreshKey, worktreeId]);

	if (summary === null || summary.files === 0) return null;
	return (
		<View className="items-center px-4 pb-2" pointerEvents="box-none">
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`Review changes in ${summary.files} files`}
				onPress={onPress}
			>
				<GlassSurface
					style={{
						minHeight: 44,
						flexDirection: "row",
						alignItems: "center",
						gap: 8,
						paddingHorizontal: 14,
					}}
				>
					<GitCompareArrows size={16} color={colors.secondaryFg} />
					<Text className="font-sans-medium text-[13px] text-foreground">
						{summary.files} {summary.files === 1 ? "file" : "files"}
					</Text>
					<Text
						className="font-mono text-[12px]"
						style={{ color: colors.diffAdded, fontVariant: ["tabular-nums"] }}
					>
						+{summary.additions}
					</Text>
					<Text
						className="font-mono text-[12px]"
						style={{ color: colors.diffRemoved, fontVariant: ["tabular-nums"] }}
					>
						−{summary.deletions}
					</Text>
				</GlassSurface>
			</Pressable>
		</View>
	);
}
