import type { Message, SessionId } from "@zuse/contracts";

const EMPTY_MESSAGES: ReadonlyArray<Message> = [];

const affectsComposerControl = (message: Message): boolean => {
	const content = message.content;
	return (
		content._tag === "user_question" ||
		content._tag === "user_question_answer" ||
		content._tag === "tool_result" ||
		(content._tag === "tool_use" && content.tool === "ExitPlanMode")
	);
};

/**
 * A stable signal for transcript changes that can alter composer controls.
 * Ordinary thinking, tool, and assistant stream rows stay in the timeline
 * without re-rendering the large composer controller on every frame.
 */
export const makeComposerMessageSignalSelector = (sessionId: SessionId) => {
	let previousSource: ReadonlyArray<Message> = EMPTY_MESSAGES;
	let previousSignal: ReadonlyArray<Message> = EMPTY_MESSAGES;

	return (
		messagesBySession: Readonly<Record<string, ReadonlyArray<Message>>>,
	): ReadonlyArray<Message> => {
		const source = messagesBySession[sessionId] ?? EMPTY_MESSAGES;
		if (previousSource === source) return previousSignal;

		let signal: ReadonlyArray<Message>;
		const previousLength = previousSource.length;
		const isAppend =
			source.length > previousLength &&
			(previousLength === 0 ||
				source[previousLength - 1] === previousSource[previousLength - 1]);
		if (isAppend) {
			const appended = source
				.slice(previousLength)
				.filter(affectsComposerControl);
			signal =
				appended.length === 0
					? previousSignal
					: [...previousSignal, ...appended];
		} else {
			const next = source.filter(affectsComposerControl);
			const unchanged =
				next.length === previousSignal.length &&
				next.every((message, index) => message === previousSignal[index]);
			signal = unchanged ? previousSignal : next;
		}

		previousSource = source;
		previousSignal = signal;
		return signal;
	};
};
