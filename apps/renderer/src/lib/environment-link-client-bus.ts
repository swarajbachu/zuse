import {
	CommandId,
	type EnvironmentId,
	type EnvironmentLinkRpc,
	type FolderId,
} from "@zuse/contracts";
import { getRendererClientBus } from "./session-timeline-client-bus.ts";

export type EnvironmentLinkResult =
	typeof EnvironmentLinkRpc.successSchema.Type;

/**
 * Reads, or with `projectId`, changes which account environment project a
 * checkout resolves. Linking mutates no renderer resource, so it publishes none.
 */
export const dispatchEnvironmentLink = (
	environmentId: EnvironmentId,
	payload: {
		readonly folderId: FolderId;
		readonly projectId?: string | null;
	},
): Promise<EnvironmentLinkResult> =>
	getRendererClientBus()
		.dispatch<EnvironmentLinkResult>({
			kind: "environment.link",
			commandId: CommandId.make(`environment-link:${crypto.randomUUID()}`),
			environmentId,
			resource: null,
			payload,
			retry: "never",
			createdAt: Date.now(),
		})
		.then(({ result }) => result);
