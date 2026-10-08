import { CloudOffIcon, SentIcon, StopIcon } from "@zuse/icons/solid-rounded";
import { ActivityIndicator } from "react-native";

import { cn } from "~/lib/cn";
import { colors } from "~/theme";
import { Button } from "./ui/button";
import { HugeIcon } from "./ui/huge-icon";

/**
 * The one send/stop control for chat and new-chat composers. Mirrors the
 * desktop composer's compact send square; hitSlop keeps a 44pt target.
 */
export function ComposerSendButton({
	showInterrupt = false,
	online,
	busy,
	disabled,
	onPress,
	round = false,
}: {
	/** Collapsed capsule: a circle so it sits inside the pill's curve. */
	round?: boolean;
	showInterrupt?: boolean;
	online: boolean;
	busy: boolean;
	disabled: boolean;
	onPress: () => void;
}) {
	return (
		<Button
			size="sm"
			variant={showInterrupt ? "secondary" : online ? "primary" : "secondary"}
			className={cn(
				"h-[30px] w-[30px] px-0",
				round ? "rounded-full" : "rounded-[8px]",
			)}
			hitSlop={7}
			disabled={disabled}
			onPress={onPress}
			accessibilityLabel={
				showInterrupt
					? "Stop response"
					: online
						? "Send message"
						: "Queue message"
			}
		>
			{busy ? (
				<ActivityIndicator
					color={showInterrupt ? colors.fg : colors.primaryForeground}
				/>
			) : showInterrupt ? (
				<HugeIcon icon={StopIcon} size={12} color={colors.fg as string} />
			) : online ? (
				<HugeIcon icon={SentIcon} size={13} color={colors.primaryForeground} />
			) : (
				<HugeIcon icon={CloudOffIcon} size={13} color={colors.fg as string} />
			)}
		</Button>
	);
}
