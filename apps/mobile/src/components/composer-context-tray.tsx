import type { FileRef, SkillRef } from "@zuse/contracts";
import { File, Folder, Sparkles, X } from "lucide-react-native";
import { Pressable, ScrollView, Text, View } from "react-native";

import { colors } from "~/theme";

export function ComposerContextTray({
	fileRefs,
	skillRefs,
	onRemoveFile,
	onRemoveSkill,
}: {
	fileRefs: readonly FileRef[];
	skillRefs: readonly SkillRef[];
	onRemoveFile: (relPath: string) => void;
	onRemoveSkill: (name: string) => void;
}) {
	if (fileRefs.length === 0 && skillRefs.length === 0) return null;
	return (
		<ScrollView
			horizontal
			showsHorizontalScrollIndicator={false}
			contentContainerClassName="gap-2 pb-1"
		>
			{fileRefs.map((file) => {
				const Icon = file.kind === "directory" ? Folder : File;
				return (
					<ContextChip
						key={`file:${file.relPath}`}
						label={file.relPath}
						icon={<Icon size={14} color={colors.secondaryFg} />}
						onRemove={() => onRemoveFile(file.relPath)}
					/>
				);
			})}
			{skillRefs.map((skill) => (
				<ContextChip
					key={`skill:${skill.name}`}
					label={`/${skill.name}`}
					icon={<Sparkles size={14} color={colors.secondaryFg} />}
					onRemove={() => onRemoveSkill(skill.name)}
				/>
			))}
		</ScrollView>
	);
}

function ContextChip({
	label,
	icon,
	onRemove,
}: {
	label: string;
	icon: React.ReactNode;
	onRemove: () => void;
}) {
	return (
		<View className="min-h-11 flex-row items-center gap-2 rounded-xl bg-muted px-3">
			{icon}
			<Text
				numberOfLines={1}
				className="max-w-44 font-sans text-xs text-foreground"
			>
				{label}
			</Text>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`Remove ${label}`}
				hitSlop={8}
				onPress={onRemove}
				className="h-8 w-8 items-center justify-center"
			>
				<X size={14} color={colors.secondaryFg} />
			</Pressable>
		</View>
	);
}
