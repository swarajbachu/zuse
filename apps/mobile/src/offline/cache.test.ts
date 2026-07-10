import { describe, expect, test } from "vitest";
import { Message } from "@zuse/contracts";
import { Schema } from "effect";

import { parsePairingUrl, slugConnectionKey } from "./cache-utils";

describe("mobile offline helpers", () => {
  test("parses Track C pairing URLs", () => {
    expect(parsePairingUrl("zuse://?pairingUrl=127.0.0.1:8787#token=abc")).toEqual({
      host: "127.0.0.1",
      port: 8787,
      token: "abc"
    });
  });

  test("slugs connection keys for cache paths", () => {
    expect(slugConnectionKey("127.0.0.1:8787")).toBe("127.0.0.1_8787");
  });

  test("round-trips encoded messages", () => {
    const decoded = Schema.decodeUnknownSync(Message)({
      id: "msg-test",
      sessionId: "session-test",
      role: "assistant",
      content: { _tag: "assistant", text: "hello" },
      createdAt: "2026-07-03T00:00:00.000Z"
    });
    expect(Schema.decodeUnknownSync(Message)(Schema.encodeSync(Message)(decoded))).toEqual(
      decoded
    );
  });
});
