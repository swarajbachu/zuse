import type { GitPrInfo } from "@zuse/wire";

export type BranchStateTone = "brand" | "neutral" | "danger" | "success" | "warning";

export type BranchStatePresentation = {
  label: string;
  tone: BranchStateTone;
};

export const branchStatePresentation = (
  info: GitPrInfo | null,
): BranchStatePresentation | null => {
  if (info === null || info.state === "none") return null;
  if (info.mergeable === "conflicting") {
    return { label: "Needs resolve", tone: "danger" };
  }
  if (info.checks === "failure") {
    return { label: "Checks failed", tone: "danger" };
  }
  if (info.checks === "pending") {
    return { label: "Checks running", tone: "warning" };
  }
  switch (info.state) {
    case "open":
      return { label: info.isDraft ? "Draft" : "Open", tone: "brand" };
    case "merged":
      return { label: "Merged", tone: "success" };
    case "closed":
      return { label: "Closed", tone: "neutral" };
  }
};
