import { describe, expect, test } from "bun:test";

import {
  buildToolResultsByItemId,
  extractEditSummaries,
  summarizeValue,
} from "./message-presentation";

describe("message presentation helpers", () => {
  test("pairs tool results by item id", () => {
    const results = buildToolResultsByItemId([
      {
        id: "message-1",
        createdAt: new Date(),
        content: {
          _tag: "tool_result",
          itemId: "tool-1",
          output: "done",
          isError: false,
        },
      },
    ] as never);

    expect(results.get("tool-1")?.output).toBe("done");
  });

  test("extracts edit stats for edit, write, and multiedit inputs", () => {
    expect(
      extractEditSummaries("Edit", {
        file_path: "src/app.ts",
        old_string: "one\nline",
        new_string: "one\nnew\nline",
      }),
    ).toEqual([
      {
        path: "src/app.ts",
        added: 3,
        removed: 2,
        preview: "one\nnew\nline",
      },
    ]);

    expect(
      extractEditSummaries("Write", {
        file_path: "src/new.ts",
        content: "hello",
      })[0],
    ).toMatchObject({ path: "src/new.ts", added: 1, removed: 0 });

    expect(
      extractEditSummaries("MultiEdit", {
        file_path: "src/multi.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d\ne" },
        ],
      }).map((summary) => summary.path),
    ).toEqual(["src/multi.ts #1", "src/multi.ts #2"]);
  });

  test("summarizes long values", () => {
    const value = summarizeValue({ message: "x".repeat(500) }, 40);
    expect(value.length).toBe(40);
    expect(value.endsWith("…")).toBe(true);
  });
});
