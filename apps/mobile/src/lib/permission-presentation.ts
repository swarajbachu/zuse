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
