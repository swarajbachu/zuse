import type { ReactNode } from "react";
import { View } from "react-native";

/** Gives compact native composer controls a shared 44pt alignment box. */
export function ComposerActionSlot({ children }: { children: ReactNode }) {
	return (
		<View className="h-11 w-10 items-center justify-center">{children}</View>
	);
}
