/**
 * Dummy helpers for Zuse PR review testing — safe to delete after QA.
 */

export type ReviewSeverity = "nit" | "suggestion" | "blocking";

export interface DummyReviewNote {
  file: string;
  line: number;
  severity: ReviewSeverity;
  body: string;
}

export function formatReviewNote(note: DummyReviewNote): string {
  const prefix = note.severity === "blocking" ? "🚫" : note.severity === "suggestion" ? "💡" : "✨";
  return `${prefix} ${note.file}:${note.line} — ${note.body}`;
}

export function summarizeNotes(notes: DummyReviewNote[]): string {
  const counts = notes.reduce(
    (acc, note) => {
      acc[note.severity] += 1;
      return acc;
    },
    { nit: 0, suggestion: 0, blocking: 0 } as Record<ReviewSeverity, number>,
  );
  return `nits=${counts.nit}, suggestions=${counts.suggestion}, blocking=${counts.blocking}`;
}

export const SAMPLE_NOTES: DummyReviewNote[] = [
  { file: "apps/web/lib/utils.ts", line: 22, severity: "nit", body: "Consider exporting twMerge for tests." },
  { file: "apps/mobile/src/theme.ts", line: 12, severity: "suggestion", body: "Add dark-mode variant for success color." },
  { file: "README.md", line: 145, severity: "nit", body: "Link to internal QA doc?" },
];