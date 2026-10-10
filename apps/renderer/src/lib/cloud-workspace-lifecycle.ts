import type { CloudWorkspace } from "@zuse/contracts";

/** Reading a cloud transcript must never wake paused compute. Commands and
 * live tools acquire `wake` through ClientBus; a ready runtime may be attached
 * in the background to refresh an already-rendered local checkpoint. */
export const cloudTranscriptActivation = (
	summary: Pick<CloudWorkspace, "state" | "runtimeState">,
): "sync" | "connect" =>
	isCloudWorkspaceAttachable(summary) ? "connect" : "sync";

import { Effect, Option, Stream } from "effect";

/** Socket attachment does not wait for repository preparation. Paused and
 * terminal workspaces never gain permission from a stale online observation. */
export const isCloudWorkspaceAttachable = (
	workspace: Pick<CloudWorkspace, "runtimeState" | "state">,
): boolean =>
	(workspace.state === "setup" || workspace.state === "ready") &&
	workspace.runtimeState === "online";

export const isCloudWorkspaceReady = (
	workspace: Pick<CloudWorkspace, "runtimeState" | "state">,
): boolean =>
	workspace.state === "ready" && workspace.runtimeState === "online";

export const cloudWorkspaceStartupError = (
	workspace: Pick<CloudWorkspace, "state" | "statusCode">,
): Error | null =>
	workspace.state === "failed"
		? new Error(`Cloud startup failed during ${workspace.statusCode}.`)
		: workspace.state === "archived" ||
				workspace.state === "deleting" ||
				workspace.state === "deleted"
			? new Error(`Cloud startup stopped during ${workspace.statusCode}.`)
			: null;

/** Wait for the server-owned lifecycle stream to reach a terminal attach state. */
export const waitForCloudWorkspaceReady = (
	stream: Stream.Stream<CloudWorkspace, unknown>,
	onWorkspace?: (workspace: CloudWorkspace) => void,
): Promise<CloudWorkspace> =>
	Effect.runPromise(
		stream.pipe(
			Stream.tap((workspace) => {
				onWorkspace?.(workspace);
				const error = cloudWorkspaceStartupError(workspace);
				return error === null ? Effect.void : Effect.fail(error);
			}),
			Stream.filter(isCloudWorkspaceReady),
			Stream.runHead,
			Effect.flatMap((workspace) =>
				Option.match(workspace, {
					onNone: () =>
						Effect.fail(
							new Error("Cloud lifecycle stream ended before ready."),
						),
					onSome: Effect.succeed,
				}),
			),
		),
	);
