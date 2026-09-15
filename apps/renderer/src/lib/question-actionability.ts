import type { PresentedSessionInteraction } from "@zuse/client-runtime/session-presentation";
import type {
	PermissionRequest,
	QuestionAttachment,
	SessionId,
	SessionInteraction,
} from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";

export type QuestionAttachmentsByKey = Readonly<
	Record<string, QuestionAttachment>
>;

export type PresentedQuestionInteraction = PresentedSessionInteraction &
	Readonly<{
		interaction: Extract<SessionInteraction, { readonly _tag: "Question" }>;
	}>;

export type PresentedPermissionInteraction = PresentedSessionInteraction &
	Readonly<{
		interaction: Extract<SessionInteraction, { readonly _tag: "Permission" }>;
	}>;

export type PresentedQuestionSelection = Readonly<{
	question: PresentedQuestionInteraction;
	actionable: boolean;
}>;

const isPresentedQuestion = (
	item: PresentedSessionInteraction,
): item is PresentedQuestionInteraction => item.interaction._tag === "Question";

const isPresentedPermission = (
	item: PresentedSessionInteraction,
): item is PresentedPermissionInteraction =>
	item.interaction._tag === "Permission";

/**
 * Choose one coherent question for the composer. A live callback wins over an
 * earlier detached durable record; if none is live, preserve the first durable
 * record as a disabled reconnecting card.
 */
export const selectPresentedQuestion = (
	sessionId: SessionId,
	interactions: ReadonlyArray<PresentedSessionInteraction>,
	attachmentsByKey: QuestionAttachmentsByKey,
): PresentedQuestionSelection | null => {
	let firstDurable: PresentedQuestionInteraction | null = null;
	for (const item of interactions) {
		if (!isPresentedQuestion(item)) continue;
		firstDurable ??= item;
		if (
			attachmentsByKey[structuralTupleKey(sessionId, item.interaction.id)] !==
			undefined
		) {
			return { question: item, actionable: true };
		}
	}
	return firstDurable === null
		? null
		: { question: firstDurable, actionable: false };
};

/**
 * Preserve presentation overlays while proving each durable permission still
 * has a live provider callback. Ordering is stable and server-authored.
 */
export const findPresentedPermissions = (
	interactions: ReadonlyArray<PresentedSessionInteraction>,
	requestsById: Readonly<Record<string, PermissionRequest>>,
): ReadonlyArray<PresentedPermissionInteraction> =>
	interactions
		.flatMap((item): PresentedPermissionInteraction[] => {
			if (!isPresentedPermission(item)) return [];
			const request = requestsById[item.interaction.request.id];
			return request === undefined
				? []
				: [
						{
							...item,
							interaction: { ...item.interaction, request },
						},
					];
		})
		.toSorted(
			(a, b) =>
				a.interaction.request.requestedAt.getTime() -
				b.interaction.request.requestedAt.getTime(),
		);

/** Remove only question interactions without live callback authority. */
export const filterActionableQuestionInteractions = (
	sessionId: SessionId,
	interactions: ReadonlyArray<SessionInteraction>,
	attachmentsByKey: QuestionAttachmentsByKey,
): ReadonlyArray<SessionInteraction> =>
	interactions.filter(
		(interaction) =>
			interaction._tag !== "Question" ||
			attachmentsByKey[structuralTupleKey(sessionId, interaction.id)] !==
				undefined,
	);
