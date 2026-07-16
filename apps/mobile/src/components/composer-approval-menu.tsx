import type { RuntimeMode } from "@zuse/contracts";

/** Non-iOS fallback: native menu unavailable, renders nothing (iOS-first). */
export function ComposerApprovalMenu(_props: {
	runtimeMode: RuntimeMode;
	onChange: (mode: RuntimeMode) => void;
}) {
	return null;
}
