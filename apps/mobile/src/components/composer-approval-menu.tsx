import type { ProviderId, RuntimeMode } from "@zuse/contracts";

/** Non-iOS fallback: native menu unavailable, renders nothing (iOS-first). */
export function ComposerApprovalMenu(_props: {
	runtimeMode: RuntimeMode;
	providerId: ProviderId;
	onChange: (mode: RuntimeMode) => void;
}) {
	return null;
}
