import "@zuse/i18n/english/chat";
import type { SessionInteractionSubmission } from "@zuse/client-runtime/session-presentation";
import type {
	AgentItemId,
	EnvironmentId,
	SessionId,
	UserQuestion,
	UserQuestionAnswer,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Check, ChevronLeft, ChevronRight, PenLine, X } from "lucide-react";
import type React from "react";
import { useEffect, useId, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useSessionsStore } from "../../store/sessions.ts";

/** Single-select picks stay visible briefly before the question advances. */
const PICK_ADVANCE_DELAY_MS = 160;

export interface QuestionAnswerInput {
	readonly environmentId: EnvironmentId;
	readonly sessionId: SessionId;
	readonly itemId: AgentItemId;
	readonly questions: ReadonlyArray<UserQuestion>;
	readonly disabled?: boolean;
	readonly expired?: boolean;
	readonly submission?: SessionInteractionSubmission;
	readonly submissionError?: string | null;
}

interface DraftAnswer {
	readonly selected: ReadonlyArray<number>;
	readonly other: string;
}

interface Progress {
	readonly itemId: AgentItemId | null;
	readonly activeIdx: number;
	readonly drafts: ReadonlyArray<DraftAnswer>;
}

const emptyDraft = (): DraftAnswer => ({ selected: [], other: "" });

const draftComplete = (draft: DraftAnswer | undefined): boolean =>
	draft !== undefined &&
	(draft.selected.length > 0 || draft.other.trim().length > 0);

const freshProgress = (input: QuestionAnswerInput | null): Progress => ({
	itemId: input?.itemId ?? null,
	activeIdx: 0,
	drafts: input?.questions.map(emptyDraft) ?? [],
});

export interface QuestionAnswerController {
	readonly question: UserQuestion;
	readonly questionIndex: number;
	readonly questionCount: number;
	readonly draft: DraftAnswer;
	readonly drafts: ReadonlyArray<DraftAnswer>;
	readonly multi: boolean;
	readonly last: boolean;
	/** True while answers cannot change: reconnecting, expired or submitting. */
	readonly locked: boolean;
	readonly busy: boolean;
	readonly expired: boolean;
	readonly disabled: boolean;
	readonly submission: SessionInteractionSubmission;
	readonly submissionError: string | null;
	readonly pick: (optionIdx: number) => void;
	readonly goTo: (questionIdx: number) => void;
	readonly dismiss: () => void;
	/** Whether the composer's send action can answer with `hasText` typed. */
	readonly canAnswer: (hasText: boolean) => boolean;
	/**
	 * Answers the active question with the composer text plus any picks.
	 * Resolves true once the composer text has been consumed.
	 */
	readonly answer: (text: string) => Promise<boolean>;
}

/**
 * Draft and submission state for the composer's pending question. The
 * composer owns the free-text answer; this hook owns picks and progression.
 */
export function useQuestionAnswer(
	input: QuestionAnswerInput | null,
): QuestionAnswerController | null {
	const answerQuestion = useSessionsStore((s) => s.answerQuestion);
	const cancelQuestion = useSessionsStore((s) => s.cancelQuestion);
	const itemId = input?.itemId ?? null;
	const [stored, setProgress] = useState<Progress>(() => freshProgress(input));
	const [submitting, setSubmitting] = useState(false);
	const submittingRef = useRef(false);
	const pickTimerRef = useRef<number | null>(null);

	const progress = stored.itemId === itemId ? stored : freshProgress(input);
	if (stored.itemId !== itemId) {
		setProgress(progress);
		submittingRef.current = false;
		if (submitting) setSubmitting(false);
	}

	const submission = input?.submission ?? "pending";
	useEffect(() => {
		if (submission === "failed") {
			submittingRef.current = false;
			setSubmitting(false);
		}
	}, [submission]);

	const clearPickTimer = () => {
		if (pickTimerRef.current === null) return;
		window.clearTimeout(pickTimerRef.current);
		pickTimerRef.current = null;
	};
	// A delayed pick only advances the question it was made on.
	useEffect(() => clearPickTimer, [itemId, progress.activeIdx]);

	if (input === null) return null;
	const { questions } = input;
	const question = questions[progress.activeIdx];
	if (question === undefined) return null;

	const disabled = input.disabled === true;
	const expired = input.expired === true;
	const authoritativeSubmitting = submission === "submitting";
	const busy = submitting || authoritativeSubmitting;
	const locked = disabled || expired || busy;
	const multi = question.multiSelect === true;
	const last = progress.activeIdx === questions.length - 1;
	const draft = progress.drafts[progress.activeIdx] ?? emptyDraft();

	const withDraft = (next: DraftAnswer): ReadonlyArray<DraftAnswer> =>
		progress.drafts.map((d, i) => (i === progress.activeIdx ? next : d));

	const submitDrafts = async (
		drafts: ReadonlyArray<DraftAnswer>,
	): Promise<boolean> => {
		if (locked || submittingRef.current) return false;
		if (!questions.every((_q, i) => draftComplete(drafts[i]))) return false;
		const answers: ReadonlyArray<UserQuestionAnswer> = drafts.map((d, i) => ({
			questionIndex: i,
			selected: d.selected,
			...(d.other.trim().length > 0 ? { other: d.other.trim() } : {}),
		}));
		submittingRef.current = true;
		setSubmitting(true);
		try {
			await answerQuestion(
				input.environmentId,
				input.sessionId,
				input.itemId,
				answers,
			);
			return true;
		} catch {
			submittingRef.current = false;
			setSubmitting(false);
			return false;
		}
	};

	const commit = (next: DraftAnswer): Promise<boolean> => {
		const drafts = withDraft(next);
		if (last) {
			setProgress({ ...progress, drafts });
			return submitDrafts(drafts);
		}
		setProgress({ ...progress, drafts, activeIdx: progress.activeIdx + 1 });
		return Promise.resolve(true);
	};

	return {
		question,
		questionIndex: progress.activeIdx,
		questionCount: questions.length,
		draft,
		drafts: progress.drafts,
		multi,
		last,
		locked,
		busy,
		expired,
		disabled,
		submission,
		submissionError: input.submissionError ?? null,
		pick: (optionIdx) => {
			if (locked || pickTimerRef.current !== null) return;
			if (multi) {
				const selected = draft.selected.includes(optionIdx)
					? draft.selected.filter((i) => i !== optionIdx)
					: [...draft.selected, optionIdx];
				setProgress({ ...progress, drafts: withDraft({ ...draft, selected }) });
				return;
			}
			const next = { selected: [optionIdx], other: "" };
			setProgress({ ...progress, drafts: withDraft(next) });
			pickTimerRef.current = window.setTimeout(() => {
				pickTimerRef.current = null;
				void commit(next);
			}, PICK_ADVANCE_DELAY_MS);
		},
		goTo: (questionIdx) => {
			if (locked) return;
			clearPickTimer();
			setProgress({
				...progress,
				activeIdx: Math.max(0, Math.min(questions.length - 1, questionIdx)),
			});
		},
		dismiss: () => {
			if (busy || submittingRef.current) return;
			submittingRef.current = true;
			setSubmitting(true);
			void cancelQuestion(
				input.environmentId,
				input.sessionId,
				input.itemId,
			).catch(() => {
				submittingRef.current = false;
				setSubmitting(false);
			});
		},
		canAnswer: (hasText) =>
			!locked && (hasText || (multi && draft.selected.length > 0)),
		answer: (text) => {
			const other = text.trim();
			if (locked || (other.length === 0 && !(multi && draftComplete(draft))))
				return Promise.resolve(false);
			clearPickTimer();
			return commit({
				selected: multi || other.length === 0 ? draft.selected : [],
				other,
			});
		},
	};
}

/** The pending question, attached to the top of the composer. */
export function QuestionTray({
	answer,
}: {
	readonly answer: QuestionAnswerController;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const questionId = useId();
	const panelRef = useRef<HTMLFieldSetElement>(null);
	const { question, draft, multi, locked, pick } = answer;
	const pickRef = useRef(pick);
	pickRef.current = pick;

	// Number keys pick an option unless the user is typing somewhere.
	useEffect(() => {
		if (locked) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (!/^[1-9]$/.test(event.key)) return;
			const target = event.target;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				(target instanceof HTMLElement && target.isContentEditable)
			)
				return;
			const index = Number(event.key) - 1;
			if (index >= question.options.length) return;
			event.preventDefault();
			pickRef.current(index);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [locked, question]);

	const onArrowKey = (event: React.KeyboardEvent<HTMLFieldSetElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const options = Array.from(
			panelRef.current?.querySelectorAll<HTMLButtonElement>(
				"[data-question-option]",
			) ?? [],
		);
		const current = options.indexOf(
			document.activeElement as HTMLButtonElement,
		);
		if (current < 0) return;
		event.preventDefault();
		const step = event.key === "ArrowDown" ? 1 : -1;
		options[(current + step + options.length) % options.length]?.focus();
	};

	const status =
		answer.submission === "failed"
			? null
			: answer.expired
				? uiMessage("chat:question_expired")
				: answer.disabled
					? uiMessage("chat:question_reconnecting")
					: answer.submission === "submitting"
						? uiMessage("chat:answer_submitting")
						: null;
	const other = draft.other.trim();

	return (
		<fieldset
			ref={panelRef}
			aria-labelledby={questionId}
			aria-busy={answer.busy || undefined}
			onKeyDown={onArrowKey}
			className="min-w-0 border-b border-border/35 text-xs last:border-b-0"
		>
			<div className="flex items-start gap-1 pb-1 pl-3 pr-1.5 pt-2">
				<div
					id={questionId}
					className="min-w-0 flex-1 pt-1 text-[13px] font-medium leading-5 text-foreground"
				>
					{question.question}
				</div>
				{answer.questionCount > 1 ? (
					<div className="flex items-center text-muted-foreground">
						<button
							type="button"
							aria-label={uiMessage("chat:question_card_previous_question")}
							disabled={locked || answer.questionIndex === 0}
							onClick={() => answer.goTo(answer.questionIndex - 1)}
							className="grid size-7 place-items-center rounded-md hover:bg-muted disabled:opacity-30"
						>
							<ChevronLeft size={14} />
						</button>
						<span className="font-mono text-[10px] tabular-nums">
							{answer.questionIndex + 1}/{answer.questionCount}
						</span>
						<button
							type="button"
							aria-label={uiMessage("chat:question_card_next_question")}
							disabled={
								locked ||
								answer.last ||
								!draftComplete(answer.drafts[answer.questionIndex])
							}
							onClick={() => answer.goTo(answer.questionIndex + 1)}
							className="grid size-7 place-items-center rounded-md hover:bg-muted disabled:opacity-30"
						>
							<ChevronRight size={14} />
						</button>
					</div>
				) : null}
				<button
					type="button"
					className={cn(
						"grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
						answer.busy && "opacity-40",
					)}
					aria-label={uiMessage("chat:question_card_dismiss")}
					disabled={answer.busy}
					onClick={answer.dismiss}
				>
					<X size={14} />
				</button>
			</div>
			{answer.submission === "failed" ? (
				<p className="px-3 pb-1 text-xs text-danger-text" role="alert">
					{uiMessage("chat:answer_submit_failed")}
					{answer.submissionError === null
						? null
						: `: ${answer.submissionError}`}
				</p>
			) : status !== null ? (
				<p
					className="px-3 pb-1 text-[11px] text-muted-foreground"
					role="status"
				>
					{status}
				</p>
			) : multi ? (
				<p className="px-3 pb-1 text-[11px] text-muted-foreground">
					{uiMessage("chat:question_card_multiple_choice_hint")}
				</p>
			) : null}
			<div className="flex max-h-64 flex-col gap-px overflow-y-auto px-1.5 pb-1.5">
				{question.options.map((option, index) => {
					const picked = draft.selected.includes(index);
					return (
						<button
							key={`${answer.questionIndex}-${index}`}
							type="button"
							data-question-option
							aria-pressed={picked}
							disabled={locked}
							className={cn(
								"flex min-h-8 items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left outline-none transition-colors duration-100 disabled:opacity-40",
								picked
									? "bg-muted/80 text-foreground"
									: "text-foreground/80 hover:bg-muted/40 focus-visible:bg-muted/40",
							)}
							onClick={() => pick(index)}
						>
							<span
								aria-hidden="true"
								className={cn(
									"grid size-5 shrink-0 place-items-center rounded-md font-mono text-[10px] transition-colors duration-100",
									picked
										? "bg-primary text-primary-foreground"
										: "bg-muted/60 text-muted-foreground",
								)}
							>
								{multi && picked ? <Check className="size-3" /> : index + 1}
							</span>
							<span className="min-w-0 flex-1 text-xs leading-4">{option}</span>
						</button>
					);
				})}
				{other.length > 0 ? (
					<div className="flex min-h-8 items-center gap-2.5 rounded-lg bg-muted/80 px-1.5 py-1.5 text-foreground">
						<span
							aria-hidden="true"
							className="grid size-5 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"
						>
							<PenLine className="size-3" />
						</span>
						<span className="min-w-0 flex-1 truncate text-xs leading-4">
							{other}
						</span>
					</div>
				) : null}
			</div>
		</fieldset>
	);
}
