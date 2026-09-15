import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import {
	makeResourceKey,
	type ResourceKey,
} from "@zuse/client-runtime/resource-ref";
import {
	emptyResourceView,
	type ResourceView,
} from "@zuse/client-runtime/resource-state";
import { EnvironmentId, type QuestionAttachmentChange } from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useMemo } from "react";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import type { QuestionAttachmentsByKey } from "./question-actionability.ts";
import { isRpcClientTransportError, type MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";
import { useClientBusResource } from "./use-client-bus-resource.ts";

export type EnvironmentQuestionAttachmentsData = Readonly<{
	attachmentsByKey: QuestionAttachmentsByKey;
}>;

const emptyData = (): EnvironmentQuestionAttachmentsData => ({
	attachmentsByKey: {},
});

export const applyQuestionAttachmentChange = (
	current: QuestionAttachmentsByKey,
	change: QuestionAttachmentChange,
): QuestionAttachmentsByKey => {
	if (change._tag === "snapshot") {
		return Object.fromEntries(
			change.attachments.map((attachment) => [
				structuralTupleKey(attachment.sessionId, attachment.itemId),
				attachment,
			]),
		);
	}
	if (change._tag === "change") {
		return {
			...current,
			[structuralTupleKey(
				change.attachment.sessionId,
				change.attachment.itemId,
			)]: change.attachment,
		};
	}
	const next = { ...current };
	delete next[structuralTupleKey(change.sessionId, change.itemId)];
	return next;
};

const keyFor = (environmentId: EnvironmentId) =>
	makeResourceKey<EnvironmentQuestionAttachmentsData>(
		"environment-question-attachments",
		{ environmentId },
	);

const environmentFrom = (key: ResourceKey<unknown>): EnvironmentId | null =>
	key.kind === "environment-question-attachments" && !("sessionId" in key.ref)
		? key.ref.environmentId
		: null;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const makeDriver = (): ResourceDriver<
	MemoizeClient,
	EnvironmentQuestionAttachmentsData
> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			if (environmentFrom(context.key) === null) return;
			active = true;
			const epoch = `environment-question-attachments:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			let current = context.data ?? emptyData();
			const program = Stream.runForEach(
				context.client["session.questionAttachments"]({}),
				(change) =>
					Effect.sync(() => {
						if (!active || !context.isCurrent()) return;
						current = context.snapshot()?.data ?? current;
						current = {
							attachmentsByKey: applyQuestionAttachmentChange(
								current.attachmentsByKey,
								change,
							),
						};
						version += 1;
						context.emit({
							data: current,
							cursor: { epoch, version },
							resetEpoch: version === 1,
							sync: "live",
						});
					}),
			).pipe(
				Effect.andThen(
					Effect.fail(
						new Error("Question attachment stream ended unexpectedly"),
					),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						const failure = Cause.squash(cause);
						context.emit({ sync: "failed" });
						if (!isRpcClientTransportError(failure)) return;
						getRendererClientBus().reportConnectionFault(
							context.key.ref.environmentId,
							{ phase: "failed", message: messageOf(failure) },
							context.generation,
						);
					}),
				),
			);
			fiber = Effect.runFork(program);
		},
		stop: () => {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

registerRendererResourceDriver("environment-question-attachments", (key) =>
	environmentFrom(key) === null
		? null
		: (makeDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const EMPTY = emptyResourceView<EnvironmentQuestionAttachmentsData>();

export const useEnvironmentQuestionAttachments = (
	environmentId?: EnvironmentId,
): ResourceView<EnvironmentQuestionAttachmentsData> => {
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const selectedEnvironmentId =
		environmentId ?? EnvironmentId.make(activeEnvironmentId);
	const key = useMemo(
		() => keyFor(selectedEnvironmentId),
		[selectedEnvironmentId],
	);
	return useClientBusResource(key, EMPTY, "connect");
};
