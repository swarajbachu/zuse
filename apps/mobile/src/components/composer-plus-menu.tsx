import { Plus } from "lucide-react-native";
import { Pressable } from "react-native";

import { colors } from "~/theme";

/** Non-iOS fallback opens the document picker directly. */
export function ComposerPlusMenu(props: {
	goalMode: boolean;
	planMode: boolean;
	onPickImages: () => void;
	onPickFiles: () => void;
	onToggleGoal: (next: boolean) => void;
	onTogglePlan: (next: boolean) => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel="Add attachment"
			className="h-11 w-11 items-center justify-center"
			onPress={props.onPickFiles}
		>
			<Plus size={21} color={colors.fg} />
		</Pressable>
	);
}
