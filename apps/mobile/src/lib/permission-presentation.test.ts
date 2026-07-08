import { describe, expect, test } from "bun:test";

import { describePermissionKind } from "./permission-presentation";

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
});
