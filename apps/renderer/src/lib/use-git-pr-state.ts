import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import { useMemo } from "react";
import { resolveGitPrState } from "./git-pr-state.ts";
import {
	useGitPrDetailsResource,
	useGitWorkspaceResource,
} from "./git-workspace-client-bus.ts";

export function useGitPrState(
	ref: ExecutionRef | null,
	requestDetails = false,
) {
	const gitView = useGitWorkspaceResource(ref, "connect");
	const prDetailsView = useGitPrDetailsResource(
		ref,
		requestDetails || gitView.data?.pr?.state === "open"
			? "connect"
			: "cache-only",
	);
	const pr = gitView.data?.pr ?? null;
	const details = prDetailsView.data?.details ?? null;
	const branch = gitView.data?.status?.branch ?? null;
	const state = useMemo(
		() => resolveGitPrState(pr, details, branch),
		[pr, details, branch],
	);
	return { gitView, prDetailsView, ...state };
}
