import type { PermissionKind } from "@zuse/wire";

export type PermissionSummary = {
  label: string;
  detail: string;
  mono: boolean;
};

export const describePermissionKind = (
  kind: PermissionKind,
): PermissionSummary => {
  switch (kind._tag) {
    case "FileWrite":
      return { label: "Write file", detail: kind.path, mono: true };
    case "Bash":
      return { label: "Run command", detail: kind.command, mono: true };
    case "Network":
      return { label: "Network request", detail: kind.url, mono: true };
    case "Other":
      return { label: kind.tool, detail: kind.summary, mono: false };
  }
};

/**
 * Bold headline question for the docked permission panel, phrased per kind so
 * the ask reads naturally above the command/detail box.
 */
export const permissionQuestion = (kind: PermissionKind): string => {
  switch (kind._tag) {
    case "Bash":
      return "Do you want to allow running this command?";
    case "FileWrite":
      return "Do you want to allow writing to this file?";
    case "Network":
      return "Do you want to allow this network request?";
    case "Other":
      return "Do you want to allow this action?";
  }
};
