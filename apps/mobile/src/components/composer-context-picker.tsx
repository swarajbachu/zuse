import {
	type BuiltinCommand,
	filterBuiltins,
} from "@zuse/client-runtime/composer-commands";
import type {
	FileRef,
	FolderId,
	ProviderId,
	SessionId,
	Skill,
	WorktreeId,
} from "@zuse/contracts";
import { Effect } from "effect";
import { File, Folder, Sparkles, TerminalSquare } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { listSessionSkills, searchWorkspaceFiles } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import { colors } from "~/theme";

export type ComposerPickerRow =
	| { readonly kind: "file"; readonly value: FileRef }
	| { readonly kind: "skill"; readonly value: Skill }
	| { readonly kind: "command"; readonly value: BuiltinCommand };

export function ComposerContextPicker({
	kind,
	query,
	connection,
	projectId,
	worktreeId,
	sessionId,
	providerId,
	onSelect,
}: {
	kind: "at" | "slash";
	query: string;
	connection: WsProtocolOptions;
	projectId: FolderId;
	worktreeId: WorktreeId | null;
	sessionId: SessionId;
	providerId: ProviderId;
	onSelect: (row: ComposerPickerRow) => void;
}) {
	const [files, setFiles] = useState<readonly FileRef[]>([]);
	const [skills, setSkills] = useState<readonly Skill[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let active = true;
		setLoading(true);
		const timer = setTimeout(
			() => {
				if (kind === "at") {
					void Effect.runPromise(
						searchWorkspaceFiles({
							connection,
							projectId,
							query,
							worktreeId,
							limit: 12,
						}),
					)
						.then((rows) => {
							if (active) setFiles(rows);
						})
						.catch(() => {
							if (active) setFiles([]);
						})
						.finally(() => {
							if (active) setLoading(false);
						});
					return;
				}

				void Effect.runPromise(listSessionSkills({ connection, sessionId }))
					.then((rows) => {
						if (active) setSkills(rows);
					})
					.catch(() => {
						if (active) setSkills([]);
					})
					.finally(() => {
						if (active) setLoading(false);
					});
			},
			kind === "at" ? 180 : 80,
		);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [connection, kind, projectId, query, sessionId, worktreeId]);

	const rows = useMemo<readonly ComposerPickerRow[]>(() => {
		if (kind === "at") {
			return files.slice(0, 6).map((value) => ({ kind: "file", value }));
		}
		const normalized = query.toLowerCase();
		const skillRows = skills
			.filter((skill) => skill.name.toLowerCase().startsWith(normalized))
			.map((value) => ({ kind: "skill" as const, value }));
		const commandRows = filterBuiltins(query, providerId).map((value) => ({
			kind: "command" as const,
			value,
		}));
		return [...skillRows, ...commandRows].slice(0, 6);
	}, [files, kind, providerId, query, skills]);

	if (loading && rows.length === 0) {
		return (
			<View className="h-12 items-center justify-center">
				<ActivityIndicator color={colors.accent} />
			</View>
		);
	}
	if (rows.length === 0) return null;

	return (
		<View
			className="mb-1 overflow-hidden rounded-2xl border border-border bg-card"
			accessibilityRole="menu"
		>
			{rows.map((row) => {
				const label =
					row.kind === "file" ? row.value.relPath : `/${row.value.name}`;
				const detail =
					row.kind === "file" ? row.value.kind : row.value.description;
				const Icon =
					row.kind === "file"
						? row.value.kind === "directory"
							? Folder
							: File
						: row.kind === "skill"
							? Sparkles
							: TerminalSquare;
				return (
					<Pressable
						key={`${row.kind}:${label}`}
						accessibilityRole="menuitem"
						accessibilityLabel={`${label}, ${detail}`}
						onPress={() => onSelect(row)}
						className="min-h-11 flex-row items-center gap-3 border-b border-border/60 px-3 py-2 active:bg-muted"
					>
						<Icon size={17} color={colors.secondaryFg} />
						<View className="min-w-0 flex-1">
							<Text
								numberOfLines={1}
								className="font-sans-medium text-[13px] text-foreground"
							>
								{label}
							</Text>
							<Text
								numberOfLines={1}
								className="font-sans text-[11px] text-muted-foreground"
							>
								{detail}
							</Text>
						</View>
					</Pressable>
				);
			})}
		</View>
	);
}
