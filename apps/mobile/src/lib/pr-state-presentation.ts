import type { GitPrInfo } from "@zuse/contracts";

export type BranchStateTone = "brand" | "neutral" | "danger" | "success" | "warning";

export type BranchStatePresentation = {
  label: string;
  tone: BranchStateTone;
  icon: "pull-request" | "merged" | "closed" | "warning";
};

export const branchStatePresentation = (
  info: GitPrInfo | null,
): BranchStatePresentation | null => {
  if (info === null || info.state === "none") return null;
  if (info.mergeable === "conflicting") {
    return { label: "Needs resolve", tone: "danger", icon: "warning" };
  }
  if (info.checks === "failure") {
    return { label: "Checks failed", tone: "danger", icon: "warning" };
  }
  if (info.checks === "pending") {
    return { label: "Checks running", tone: "warning", icon: "pull-request" };
  }
  switch (info.state) {
    case "open":
      return { label: info.isDraft ? "Draft" : "Open", tone: "brand", icon: "pull-request" };
    case "merged":
      return { label: "Merged", tone: "success", icon: "merged" };
    case "closed":
      return { label: "Closed", tone: "neutral", icon: "closed" };
  }
};
