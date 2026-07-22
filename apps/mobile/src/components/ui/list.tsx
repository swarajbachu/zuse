import { ChevronRight, type LucideIcon } from "lucide-react-native";
import { Children, isValidElement } from "react";
import {
	Pressable,
	type PressableProps,
	Text,
	View,
	type ViewProps,
} from "react-native";

import { cn } from "~/lib/cn";
import { lightTap } from "~/lib/haptics";
import { colors } from "~/theme";

// iOS "grouped inset" list — the Settings.app idiom. A rounded, hairline-bordered
// container holds a run of rows separated by left-inset hairlines. Corners use
// `borderCurve: "continuous"` for the Apple squircle rather than a circular arc.
const CONTINUOUS = { borderCurve: "continuous" } as const;

type ListSectionProps = ViewProps & {
	/** Small uppercase caption above the group (iOS section header). */
	header?: string;
	/** Muted explanatory caption below the group (iOS section footer). */
	footer?: string;
};

export function ListSection({
	header,
	footer,
	children,
	className,
	...rest
}: ListSectionProps) {
	const rows = Children.toArray(children).filter(isValidElement);
	return (
		<View className={cn("gap-2", className)} {...rest}>
			{header ? (
				<Text className="px-2 font-sans text-[15px] text-muted-foreground">
					{header}
				</Text>
			) : null}
			<View
				style={CONTINUOUS}
				className="overflow-hidden rounded-3xl border border-border bg-card"
			>
				{rows.map((row, index) => (
					<View key={row.key}>
						{index > 0 ? <View className="ml-4 h-px bg-border" /> : null}
						{row}
					</View>
				))}
			</View>
			{footer ? (
				<Text className="px-4 font-sans text-[13px] leading-4 text-muted-foreground">
					{footer}
				</Text>
			) : null}
		</View>
	);
}

type ListRowProps = Omit<PressableProps, "children"> & {
	title: string;
	subtitle?: string;
	/** Leading icon rendered inside a rounded tile. */
	icon?: LucideIcon;
	iconColor?: string;
	/** `brand` = neon tile + dark glyph; `neutral` = adaptive muted tile. */
	iconTone?: "brand" | "neutral";
	/** Custom leading node (e.g. a presence dot); overrides `icon`. */
	leading?: React.ReactNode;
	/** Trailing muted value text (iOS detail value). */
	value?: string;
	/** Custom trailing node rendered before the chevron. */
	trailing?: React.ReactNode;
	/** Force the disclosure chevron on/off (defaults to on when pressable). */
	chevron?: boolean;
	destructive?: boolean;
	/** Stable semantic identifier; never derived from visible row text. */
	analyticsId?: string;
};

export function ListRow({
	title,
	subtitle,
	icon: Icon,
	iconColor,
	iconTone = "neutral",
	leading,
	value,
	trailing,
	chevron,
	destructive,
	analyticsId,
	onPress,
	disabled,
	className,
	...rest
}: ListRowProps) {
	const showChevron = chevron ?? onPress != null;
	return (
		<Pressable
			disabled={disabled}
			onPress={
				onPress
					? (event) => {
							if (analyticsId) {
								void import("~/lib/analytics").then(
									({ captureMobileControl }) =>
										captureMobileControl(analyticsId),
								);
							}
							lightTap();
							onPress(event);
						}
					: undefined
			}
			className={cn(
				"min-h-[54px] flex-row items-center gap-3 px-4 py-2.5 active:bg-card-elevated",
				disabled && "opacity-40",
				className,
			)}
			{...rest}
		>
			{leading ??
				(Icon ? (
					<View
						style={CONTINUOUS}
						className={cn(
							"h-8 w-8 items-center justify-center rounded-lg",
							iconTone === "brand" ? "bg-primary" : "bg-muted",
						)}
					>
						<Icon
							size={17}
							color={
								iconColor ??
								(iconTone === "brand" ? colors.primaryForeground : colors.fg)
							}
						/>
					</View>
				) : null)}
			<View className="min-w-0 flex-1">
				<Text
					className={cn(
						"font-sans text-[17px]",
						destructive ? "text-danger" : "text-foreground",
					)}
					numberOfLines={1}
				>
					{title}
				</Text>
				{subtitle ? (
					<Text
						className="mt-0.5 font-sans text-[13px] text-muted-foreground"
						numberOfLines={1}
					>
						{subtitle}
					</Text>
				) : null}
			</View>
			{value ? (
				<Text
					className="max-w-[45%] font-sans text-[17px] text-muted-foreground"
					numberOfLines={1}
				>
					{value}
				</Text>
			) : null}
			{trailing}
			{showChevron ? (
				<ChevronRight size={18} color={colors.tertiaryFg} />
			) : null}
		</Pressable>
	);
}
