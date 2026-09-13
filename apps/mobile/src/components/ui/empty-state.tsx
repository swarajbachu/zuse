import { type SFSymbol, SymbolView } from "expo-symbols";
import type { LucideIcon } from "lucide-react-native";
import { Text, View } from "react-native";
import { colors } from "~/theme";

export const EmptyState = ({
	icon: Icon,
	symbol,
	title,
	detail,
}: {
	icon?: LucideIcon;
	symbol?: SFSymbol;
	title: string;
	detail?: string;
}) => (
	<View className="flex-1 items-center justify-center gap-3 px-7">
		<View
			style={{ borderCurve: "continuous" }}
			className="mb-1 h-16 w-16 items-center justify-center rounded-[20px] bg-muted"
		>
			{symbol ? (
				<SymbolView
					name={symbol}
					size={27}
					weight="medium"
					tintColor={colors.fg}
				/>
			) : Icon ? (
				<Icon size={26} strokeWidth={1.8} color={colors.fg} />
			) : null}
		</View>
		<Text className="text-center font-sans-bold text-xl tracking-[-0.3px] text-foreground">
			{title}
		</Text>
		{detail !== undefined ? (
			<Text className="max-w-[320px] text-center font-sans text-[15px] leading-[21px] text-muted-foreground">
				{detail}
			</Text>
		) : null}
	</View>
);
