import { describe, expect, test } from "bun:test";

import {
  describePermissionKind,
  permissionQuestion,
} from "./permission-presentation";

describe("permission presentation helpers", () => {
  test("summarizes permission kinds for compact mobile chrome", () => {
    expect(
      describePermissionKind({ _tag: "FileWrite", path: "src/app.ts" }),
    ).toEqual({
      label: "Write file",
      detail: "src/app.ts",
      mono: true,
    });

    expect(
      describePermissionKind({ _tag: "Other", tool: "Review", summary: "Approve change" }),
    ).toEqual({
      label: "Review",
      detail: "Approve change",
      mono: false,
    });
  });

  test("phrases a headline question per kind", () => {
    expect(permissionQuestion({ _tag: "Bash", command: "ls" })).toBe(
      "Do you want to allow running this command?",
    );
    expect(permissionQuestion({ _tag: "FileWrite", path: "a.ts" })).toBe(
      "Do you want to allow writing to this file?",
    );
    expect(
      permissionQuestion({ _tag: "Network", url: "https://x.dev" }),
    ).toBe("Do you want to allow this network request?");
    expect(
      permissionQuestion({ _tag: "Other", tool: "X", summary: "y" }),
    ).toBe("Do you want to allow this action?");
  });
});
