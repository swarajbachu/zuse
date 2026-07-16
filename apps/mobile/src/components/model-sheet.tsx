import type { ProviderId } from "@zuse/contracts";

import type { ModelModeValue } from "./model-mode-menu";

/**
 * Non-iOS fallback: the native BottomSheet isn't available. The app is
 * iOS-first, so this renders nothing.
 */
export function ModelSheet(_props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	value: ModelModeValue;
	availableProviders?: readonly ProviderId[] | null;
	canChangeProvider: boolean;
	canChangeReasoning: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	return null;
}
