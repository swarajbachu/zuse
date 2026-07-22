import { unstable_batchedUpdates } from "react-native";

/** React batching for the native runtime (resolved by Metro). */
export const batchReactUpdates: (update: () => void) => void =
	unstable_batchedUpdates;
