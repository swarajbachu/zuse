import { Image } from "expo-image";
import { FileText, X } from "lucide-react-native";
import { Pressable, ScrollView, Text, View } from "react-native";

import type { LocalComposerAttachment } from "~/lib/composer-attachments";
import { colors } from "~/theme";

export function ComposerAttachmentStrip({
	attachments,
	onRemove,
}: {
	attachments: readonly LocalComposerAttachment[];
	onRemove: (id: string) => void;
}) {
	if (attachments.length === 0) return null;
	return (
		<ScrollView
			horizontal
			showsHorizontalScrollIndicator={false}
			contentContainerStyle={{ gap: 8, paddingHorizontal: 2 }}
		>
			{attachments.map((attachment) => (
				<View
					key={attachment.id}
					className="h-14 max-w-[180px] flex-row items-center gap-2 rounded-2xl bg-card-elevated px-2"
					style={{ borderCurve: "continuous" }}
				>
					{attachment.mimeType.startsWith("image/") ? (
						<Image
							source={{ uri: attachment.uri }}
							contentFit="cover"
							style={{ width: 40, height: 40, borderRadius: 10 }}
						/>
					) : (
						<View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
							<FileText size={19} color={colors.fg} />
						</View>
					)}
					<Text
						className="min-w-0 flex-1 font-sans text-[13px] text-foreground"
						numberOfLines={2}
					>
						{attachment.name}
					</Text>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={`Remove ${attachment.name}`}
						hitSlop={8}
						onPress={() => onRemove(attachment.id)}
					>
						<X size={14} color={colors.secondaryFg} />
					</Pressable>
				</View>
			))}
		</ScrollView>
	);
}
