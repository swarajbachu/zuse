import type { MemoizeRpcs, WorkspaceGatewayFrame } from "@zuse/contracts";
import { Schema } from "effect";
import { type Rpc, type RpcGroup, RpcSerialization } from "effect/unstable/rpc";

const activityRequests: ReadonlySet<string> = new Set([
	"messages.send",
	"messages.interrupt",
	"messages.background.stop",
	"messages.queue.add",
	"messages.queue.update",
	"messages.queue.delete",
	"messages.queue.runNext",
	"messages.queue.reorder",
	"messages.queue.flush",
	"messages.queue.resume",
	"session.create",
	"session.resume",
	"session.fork",
	"session.answerQuestion",
	"session.cancelQuestion",
	"session.plan.respond",
	"session.goal.set",
	"session.goal.clear",
	"permission.decide",
	"pty.open",
	"pty.write",
	"pty.restart",
	"fs.writeFile",
	"fs.createFile",
	"fs.createDirectory",
	"fs.remove",
	"fs.move",
	"fs.writeExternalFile",
	"git.switchBranch",
	"git.continueBranch",
	"git.createReviewComment",
	"git.fixFailingChecks",
	"git.commit",
	"git.push",
	"reviewGuide.generate",
	"git.pull",
	"git.stash",
	"git.stashPop",
	"git.resetRemoteApply",
	"git.resolveConflict",
	"git.mergePr",
	"git.markReady",
	"git.init",
	"git.revertFile",
	"git.restoreFileToBase",
	"git.revertAll",
	"worktree.create",
	"worktree.renameBranch",
	"worktree.rerunSetup",
	"worktree.startRun",
	"worktree.remove",
] satisfies ReadonlyArray<Rpc.Tag<RpcGroup.Rpcs<MemoizeRpcs>>>);

const isRequestEnvelope = Schema.is(
	Schema.Struct({
		_tag: Schema.Literal("Request"),
		id: Schema.Union([Schema.String, Schema.Number]),
		tag: Schema.String,
		payload: Schema.Unknown,
		headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
		traceId: Schema.optional(Schema.String),
		spanId: Schema.optional(Schema.String),
		sampled: Schema.optional(Schema.Boolean),
	}),
);

const isActivityRequest = (message: unknown): boolean =>
	typeof message === "object" &&
	message !== null &&
	Object.hasOwn(message, "payload") &&
	isRequestEnvelope(message) &&
	activityRequests.has(message.tag);

/** Activity observation must never change or consume the forwarded RPC frame. */
export const makeCloudWorkspaceRpcActivity = (publish: () => void) => {
	const parser = RpcSerialization.json.makeUnsafe();
	return (
		frame: Pick<WorkspaceGatewayFrame, "direction" | "payload">,
	): void => {
		if (frame.direction !== "client") return;
		let messages: ReadonlyArray<unknown>;
		try {
			messages = parser.decode(
				typeof frame.payload === "string"
					? frame.payload
					: new Uint8Array(frame.payload),
			);
		} catch {
			return;
		}
		if (messages.some(isActivityRequest)) publish();
	};
};
