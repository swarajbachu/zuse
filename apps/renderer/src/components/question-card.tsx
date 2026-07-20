import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { X } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";

import type {
  AgentItemId,
  SessionId,
  UserQuestion,
  UserQuestionAnswer,
} from "@zuse/contracts";

import { cn } from "~/lib/utils";

import { useSessionsStore } from "../store/sessions.ts";

interface QuestionCardProps {
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
      sessionId={sessionId}
      itemId={itemId}
      questions={questions}
    />
  );
}

function InteractiveQuestionCard({
  sessionId,
  itemId,
  questions,
}: {
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
    await answerQuestion(sessionId, itemId, answers);
    // No need to clear submitting — once answered, the parent unmounts us.
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
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="text-base text-foreground">{active.question}</div>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Dismiss"
          // Dismiss = answer with empty drafts so the SDK turn unwinds with a
          // "user declined" tool result rather than hanging forever.
          onClick={() => {
            void answerQuestion(
              sessionId,
              itemId,
              questions.map((_, i) => ({ questionIndex: i, selected: [] })),
            );
          }}
        >
          <X size={16} strokeWidth={1.8} />
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {active.options.map((opt, i) => {
          const idx = i + 1; // 1-based labels match the screenshot
          const picked = draft.selected.includes(i);
          return (
            <button
              key={`${activeIdx}-${i}`}
              type="button"
              className={cn(
                "flex items-start gap-3 rounded-md px-2 py-1.5 text-left transition-colors",
                picked
                  ? "bg-accent text-foreground"
                  : "hover:bg-accent/40 text-foreground/90",
              )}
              onClick={() => toggleOption(i)}
            >
              <span className="mt-0.5 w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {idx}
              </span>
              <span className="text-sm leading-relaxed">{opt}</span>
            </button>
          );
        })}

        {/* "Other" free-text input — labelled `0` like the screenshot. */}
        <label className="flex items-start gap-3 rounded-md px-2 py-1.5">
          <span className="mt-2 w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            0
          </span>
          <input
            type="text"
            value={draft.other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={onOtherKeyDown}
            placeholder="Type something… (press Enter)"
            className="flex-1 bg-transparent py-1 text-sm text-foreground placeholder:text-muted-foreground/70 outline-none"
            autoFocus
          />
        </label>
      </div>

      <div className="mt-3 flex items-center justify-between">
        {questions.length > 1 ? (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <button
              type="button"
              aria-label="Previous question"
              disabled={activeIdx === 0}
              onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
              className="rounded p-1 hover:text-foreground disabled:opacity-30"
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
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
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
            </button>
          </div>
        ) : (
          <span />
        )}
        <button
          type="button"
          aria-label="Submit answer"
          disabled={!complete || submitting}
          onClick={submit}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
            complete && !submitting
              ? "bg-foreground text-background hover:opacity-90"
              : "bg-muted text-muted-foreground cursor-not-allowed",
          )}
        >
          <HugeiconsIcon icon={ArrowUp01Icon} size={16} strokeWidth={2} />
        </button>
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
    <div className="rounded-lg border border-border/70 bg-card p-4 text-sm text-foreground/90">
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
