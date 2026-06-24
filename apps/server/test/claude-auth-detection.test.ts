import { describe, expect, it } from "bun:test";

import {
  claudeResultErrorText,
  looksLikeClaudeAuthFailure,
} from "../src/provider/drivers/claude.ts";

// Regression coverage for the "stuck on a dead 'Not logged in' message"
// report: an unauthenticated `claude` reports auth failures as plain output,
// which we must recognise so the renderer can paint the sign-in card.
describe("looksLikeClaudeAuthFailure", () => {
  it("matches the CLI's not-logged-in output", () => {
    expect(looksLikeClaudeAuthFailure("Not logged in · Please run /login")).toBe(
      true,
    );
    expect(
      looksLikeClaudeAuthFailure(
        "Please run /login · API Error: 401 Invalid authentication credentials",
      ),
    ).toBe(true);
    expect(looksLikeClaudeAuthFailure("Invalid API key · Fix external")).toBe(
      true,
    );
  });

  it("does not match ordinary assistant prose", () => {
    expect(
      looksLikeClaudeAuthFailure("I updated the login form component."),
    ).toBe(false);
    expect(looksLikeClaudeAuthFailure("All tests pass.")).toBe(false);
  });
});

describe("claudeResultErrorText", () => {
  it("returns null for a clean success result", () => {
    expect(
      claudeResultErrorText({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
      } as never),
    ).toBeNull();
  });

  it("extracts the 401 from a success-shaped error result", () => {
    const text = claudeResultErrorText({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Please run /login",
      api_error_status: 401,
    } as never);
    expect(text).not.toBeNull();
    expect(text).toContain("Please run /login");
    expect(text).toContain("401");
  });

  it("joins the errors[] of an error-subtype result", () => {
    const text = claudeResultErrorText({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Not logged in", "Please run /login"],
    } as never);
    expect(text).toBe("Not logged in\nPlease run /login");
  });
});
