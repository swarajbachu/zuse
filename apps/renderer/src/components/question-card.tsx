import type {
	AgentItemId,
	EnvironmentId,
	SessionId,
	UserQuestion,
	UserQuestionAnswer,
} from "@zuse/contracts";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useSessionsStore } from "../store/sessions.ts";
import { Button } from "./ui/button.tsx";

interface QuestionCardProps {
	readonly environmentId: EnvironmentId;
	readonly sessionId: SessionId;
	readonly itemId: AgentItemId;
	readonly questions: ReadonlyArray<UserQuestion>;
	/**
	 * The paired `user_question_answer` row, if any. When present, the card
	 * renders in answered state — no inputs, just a compact summary the user
	 * can scan in the timeline.
	 */
	readonly answer?: ReadonlyArray<UserQuestionAnswer>;
}

/**
 * Per-question working state for the interactive card. We don't store the
 * "active question" on disk — it's purely local until the user hits submit.
 */
interface DraftAnswer {
	readonly selected: ReadonlyArray<number>;
	readonly other: string;
}

const emptyDraft = (): DraftAnswer => ({ selected: [], other: "" });

const isComplete = (
	questions: ReadonlyArray<UserQuestion>,
	drafts: ReadonlyArray<DraftAnswer>,
): boolean =>
	questions.every((_q, i) => {
		const d = drafts[i];
		if (d === undefined) return false;
		return d.selected.length > 0 || d.other.trim().length > 0;
	});

export function QuestionCard({
	environmentId,
	sessionId,
	itemId,
	questions,
	answer,
}: QuestionCardProps) {
	if (answer !== undefined) {
		return <AnsweredQuestionCard questions={questions} answer={answer} />;
	}
	return (
		<InteractiveQuestionCard
			environmentId={environmentId}
			sessionId={sessionId}
			itemId={itemId}
			questions={questions}
		/>
	);
}

function InteractiveQuestionCard({
	environmentId,
	sessionId,
	itemId,
	questions,
}: {
	readonly environmentId: EnvironmentId;
	readonly sessionId: SessionId;
	readonly itemId: AgentItemId;
	readonly questions: ReadonlyArray<UserQuestion>;
}) {
	const answerQuestion = useSessionsStore((s) => s.answerQuestion);
	const [activeIdx, setActiveIdx] = useState(0);
	const [drafts, setDrafts] = useState<ReadonlyArray<DraftAnswer>>(() =>
		questions.map(() => emptyDraft()),
	);
	const [submitting, setSubmitting] = useState(false);

	const active = questions[activeIdx]!;
	const draft = drafts[activeIdx] ?? emptyDraft();
	const multi = active.multiSelect === true;

	const setDraft = (idx: number, next: DraftAnswer): void => {
		setDrafts((prev) => prev.map((d, i) => (i === idx ? next : d)));
	};

	/**
	 * Submit a specific drafts state. Pulled out of `submit` so `toggleOption`
	 * and the Other-input Enter handler can call it with the freshly-updated
	 * drafts without waiting for React state to flush.
	 */
	const submitWith = async (
		finalDrafts: ReadonlyArray<DraftAnswer>,
	): Promise<void> => {
		if (submitting) return;
		if (!isComplete(questions, finalDrafts)) return;
		setSubmitting(true);
		const answers: ReadonlyArray<UserQuestionAnswer> = finalDrafts.map(
			(d, i) => ({
				questionIndex: i,
				selected: d.selected,
				...(d.other.trim().length > 0 ? { other: d.other.trim() } : {}),
			}),
		);
		try {
			await answerQuestion(environmentId, sessionId, itemId, answers);
		} finally {
			setSubmitting(false);
		}
	};

	/**
	 * Commit an updated draft for the active question and decide whether to
	 * advance to the next question or submit. Auto-advance fires for
	 * single-select picks and for Enter-on-Other; multi-select keeps the
	 * card visible so the user can pick more or hit submit explicitly.
	 */
	const commitAndAdvance = (next: DraftAnswer): void => {
		const nextDrafts = drafts.map((d, i) => (i === activeIdx ? next : d));
		setDrafts(nextDrafts);
		const isLast = activeIdx === questions.length - 1;
		if (isLast) {
			void submitWith(nextDrafts);
		} else {
			setActiveIdx(activeIdx + 1);
		}
	};

	const toggleOption = (optionIdx: number): void => {
		if (multi) {
			const has = draft.selected.includes(optionIdx);
			const selected = has
				? draft.selected.filter((i) => i !== optionIdx)
				: [...draft.selected, optionIdx];
			setDraft(activeIdx, { ...draft, selected });
			return;
		}
		// Single-select: clicking the already-selected option clears it
		// (lets the user re-pick "Other" easily). Otherwise replace the
		// selection AND auto-advance — the user shouldn't have to hit submit
		// for an unambiguous single pick.
		if (draft.selected.length === 1 && draft.selected[0] === optionIdx) {
			setDraft(activeIdx, { ...draft, selected: [] });
			return;
		}
		commitAndAdvance({ ...draft, selected: [optionIdx], other: "" });
	};

	const setOther = (text: string): void => {
		// Free-text and preset picks don't conflict — the agent sees both.
		setDraft(activeIdx, { ...draft, other: text });
	};

	/**
	 * Pressing Enter inside the Other field commits the typed text as the
	 * answer for the active question. Mirrors the click-an-option flow:
	 * single-question or last-question submits, otherwise advances.
	 */
	const onOtherKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
		if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
		const trimmed = draft.other.trim();
		if (trimmed.length === 0) return;
		e.preventDefault();
		commitAndAdvance({ selected: [], other: trimmed });
	};

	const complete = useMemo(
		() => isComplete(questions, drafts),
		[questions, drafts],
	);

	const submit = (): void => {
		void submitWith(drafts);
	};

	return (
		<div className="rounded-xl bg-card/95 p-3 shadow-overlay-sm ring-1 ring-border/70">
			<div className="flex items-start justify-between gap-3">
				<div className="text-[13px] font-medium leading-5 text-foreground">
					{active.question}
				</div>
				<button
					type="button"
					className="-mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
					aria-label="Dismiss"
					// Dismiss = answer with empty drafts so the SDK turn unwinds with a
					// "user declined" tool result rather than hanging forever.
					onClick={() => {
						void answerQuestion(
							environmentId,
							sessionId,
							itemId,
							questions.map((_, i) => ({ questionIndex: i, selected: [] })),
						);
					}}
				>
					<X size={16} strokeWidth={1.8} />
				</button>
			</div>

			<div className="mt-2 flex flex-col gap-0.5">
				{active.options.map((opt, i) => {
					const picked = draft.selected.includes(i);
					return (
						<button
							key={`${activeIdx}-${i}`}
							type="button"
							className={cn(
								"flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
								picked
									? "bg-accent/70 text-foreground"
									: "hover:bg-accent/40 text-foreground/90",
							)}
							onClick={() => toggleOption(i)}
						>
							<span
								className={cn(
									"grid size-3.5 shrink-0 place-items-center border border-muted-foreground/45",
									multi ? "rounded-[3px]" : "rounded-full",
									picked && "border-primary text-primary",
								)}
							>
								{picked ? (
									multi ? (
										<Check className="size-2.5" strokeWidth={2.5} />
									) : (
										<span className="size-1.5 rounded-full bg-primary" />
									)
								) : null}
							</span>
							<span className="text-xs leading-4">{opt}</span>
						</button>
					);
				})}

				<label className="mt-1 flex h-7 items-center gap-2 rounded-md bg-muted/35 px-2 focus-within:ring-1 focus-within:ring-ring/60">
					<span className="size-3.5 shrink-0 rounded-full border border-muted-foreground/45" />
					<input
						type="text"
						value={draft.other}
						onChange={(e) => setOther(e.target.value)}
						onKeyDown={onOtherKeyDown}
						placeholder="Other answer…"
						className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
					/>
				</label>
			</div>

			<div className="mt-2 flex items-center justify-between">
				{questions.length > 1 ? (
					<div className="flex items-center gap-1.5 text-muted-foreground">
						<button
							type="button"
							aria-label="Previous question"
							disabled={activeIdx === 0}
							onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
							className="rounded p-1 hover:text-foreground disabled:opacity-30"
						>
							<ChevronLeft size={14} />
						</button>
						{questions.map((_, i) => {
							const answered =
								(drafts[i]?.selected.length ?? 0) > 0 ||
								(drafts[i]?.other.trim().length ?? 0) > 0;
							return (
								<span
									key={i}
									className={cn(
										"h-1.5 w-1.5 rounded-full",
										i === activeIdx
											? "bg-foreground"
											: answered
												? "bg-foreground/60"
												: "bg-muted-foreground/40",
									)}
								/>
							);
						})}
						<button
							type="button"
							aria-label="Next question"
							disabled={activeIdx === questions.length - 1}
							onClick={() =>
								setActiveIdx((i) => Math.min(questions.length - 1, i + 1))
							}
							className="rounded p-1 hover:text-foreground disabled:opacity-30"
						>
							<ChevronRight size={14} />
						</button>
					</div>
				) : (
					<span />
				)}
				<Button
					size="xs"
					aria-label="Submit answer"
					disabled={!complete || submitting}
					onClick={submit}
					loading={submitting}
				>
					Submit answer
				</Button>
			</div>
		</div>
	);
}

function AnsweredQuestionCard({
	questions,
	answer,
}: {
	readonly questions: ReadonlyArray<UserQuestion>;
	readonly answer: ReadonlyArray<UserQuestionAnswer>;
}) {
	return (
		<div className="rounded-lg bg-card/80 p-3 text-xs text-foreground/90 ring-1 ring-border/60">
			{questions.map((q, i) => {
				const a = answer.find((x) => x.questionIndex === i);
				const picks = (a?.selected ?? []).map(
					(idx) => q.options[idx] ?? `#${idx}`,
				);
				const other = a?.other?.trim() ?? "";
				return (
					<div key={i} className={i === 0 ? "" : "mt-2"}>
						<div className="text-foreground/70">{q.question}</div>
						<div className="mt-0.5 text-foreground">
							{picks.length > 0 ? picks.join(", ") : null}
							{picks.length > 0 && other.length > 0 ? " · " : null}
							{other.length > 0 ? (
								<span className="italic">{other}</span>
							) : null}
							{picks.length === 0 && other.length === 0 ? (
								<span className="italic text-muted-foreground">
									(cancelled)
								</span>
							) : null}
						</div>
					</div>
				);
			})}
		</div>
	);
}
