import { describe, expect, it } from "bun:test";

import {
  buildConversationText,
  isTrivialUserMessage,
  shouldDeferAutoName,
} from "../src/provider/title-generator.ts";

describe("isTrivialUserMessage", () => {
  it("treats greetings and filler as trivial", () => {
    expect(isTrivialUserMessage("hi")).toBe(true);
    expect(isTrivialUserMessage("yo!")).toBe(true);
    expect(isTrivialUserMessage("hello there")).toBe(false);
    expect(isTrivialUserMessage("fix the login bug")).toBe(false);
  });
});

describe("shouldDeferAutoName", () => {
  it("waits when only trivial user pings and no assistant reply", () => {
    expect(shouldDeferAutoName(["hi"], [])).toBe(true);
    expect(shouldDeferAutoName(["yo", "sup"], [])).toBe(true);
  });

  it("names once the assistant has replied", () => {
    expect(shouldDeferAutoName(["hi"], ["Hello! How can I help?"])).toBe(
      false,
    );
  });

  it("names immediately for substantive user tasks", () => {
    expect(shouldDeferAutoName(["fix the auth redirect"], [])).toBe(false);
  });
});

describe("buildConversationText", () => {
  it("formats ordered turns for the title prompt", () => {
    expect(
      buildConversationText([
        { role: "user", text: "hi" },
        { role: "assistant", text: "Hey!" },
        { role: "user", text: "fix login" },
      ]),
    ).toBe("User: hi\n\nAssistant: Hey!\n\nUser: fix login");
  });
});
