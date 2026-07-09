import { describe, expect, test } from "bun:test";

import { buildToolPresentation, lineCountOf, toResultText } from "./tool-presentation";

const toolUse = (tool: string, input: unknown) =>
  ({
    _tag: "tool_use",
    itemId: "tool-1",
    tool,
    input,
  }) as const;

describe("mobile tool presentation", () => {
  test("summarizes bash, read, and search tools", () => {
    expect(
      buildToolPresentation(toolUse("Bash", { command: "bun test" })).label,
    ).toBe("Bash");
    expect(
      buildToolPresentation(
        toolUse("Read", { file_path: "src/app.ts" }),
        {
          _tag: "tool_result",
          itemId: "tool-1",
          output: "one\ntwo",
          isError: false,
        },
      ).detail,
    ).toBe("2 lines - src/app.ts");
    expect(
      buildToolPresentation(toolUse("Grep", { pattern: "foo", path: "src" }))
        .detail,
    ).toBe("foo in src");
  });

  test("summarizes edits and browser tools", () => {
    const edit = buildToolPresentation(
      toolUse("Edit", {
        file_path: "src/app.ts",
        old_string: "a",
        new_string: "a\nb",
      }),
    );
    expect(edit.icon).toBe("edit");
    expect(edit.editSummaries[0]).toMatchObject({
      path: "src/app.ts",
      added: 2,
      removed: 1,
    });

    expect(
      buildToolPresentation(toolUse("mcp__zuse__browser_screenshot", {})).icon,
    ).toBe("camera");
  });

  test("normalizes tool result text", () => {
    expect(toResultText([{ type: "text", text: "hello" }])).toBe("hello");
    expect(lineCountOf("a\nb\nc")).toBe(3);
  });

  test("builds compact inline labels per tool", () => {
    expect(
      buildToolPresentation(toolUse("Bash", { command: "pwd && ls\nmore" }))
        .inlineLabel,
    ).toBe("Ran pwd && ls");
    expect(
      buildToolPresentation(toolUse("Read", { file_path: "src/app.ts" }))
        .inlineLabel,
    ).toBe("Read app.ts");
    expect(
      buildToolPresentation(
        toolUse("Write", { file_path: "a/b/new.ts", content: "x" }),
      ).inlineLabel,
    ).toBe("Created new.ts");
    expect(
      buildToolPresentation(
        toolUse("Edit", {
          file_path: "src/app.ts",
          old_string: "a",
          new_string: "b",
        }),
      ).inlineLabel,
    ).toBe("Edited app.ts");
    // Falls back to the tool label when the natural argument is missing.
    expect(buildToolPresentation(toolUse("Bash", {})).inlineLabel).toBe("Bash");
    expect(
      buildToolPresentation(toolUse("Grep", { pattern: "foo", path: "src" }))
        .inlineLabel,
    ).toBe("Grep");
  });

  test("summarizes file changes across edits", () => {
    expect(
      buildToolPresentation(
        toolUse("Edit", {
          file_path: "src/app.ts",
          old_string: "a",
          new_string: "a\nb\nc",
        }),
      ).fileChangeSummary,
    ).toBe("1 file changed +3 −1");
    expect(
      buildToolPresentation(toolUse("Bash", { command: "ls" })).fileChangeSummary,
    ).toBeNull();
  });
});
