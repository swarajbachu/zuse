import { describe, expect, it } from "vitest";

import {
  latestProposedPlanMarkdown,
  PLAN_APPROVAL_PROMPT,
  proposedPlanMarkdownFromContent,
} from "../../src/proposed-plan.js";

describe("proposed plan extraction", () => {
  it("extracts a native ExitPlanMode plan", () => {
    expect(
      proposedPlanMarkdownFromContent({
        _tag: "tool_use",
        tool: "ExitPlanMode",
        input: { plan: "  # Native plan\n\nShip it.  " },
      }),
    ).toBe("# Native plan\n\nShip it.");
  });

	it("extracts the final complete tagged assistant plan", () => {
    expect(
      proposedPlanMarkdownFromContent({
        _tag: "assistant",
        text: [
          "<proposed_plan>Old</proposed_plan>",
          "<proposed_plan>",
          "# Current plan",
          "</proposed_plan>",
        ].join("\n"),
      }),
    ).toBe("# Current plan");
	});

	it("extracts a provider-marked plan item", () => {
		expect(
			proposedPlanMarkdownFromContent({
				_tag: "assistant",
				text: "  # Provider plan  ",
				isPlan: true,
			}),
		).toBe("# Provider plan");
	});

  it("ignores empty and incomplete tagged plans", () => {
    expect(
      proposedPlanMarkdownFromContent({
        _tag: "assistant",
        text: "<proposed_plan>still streaming",
      }),
    ).toBeNull();
    expect(
      proposedPlanMarkdownFromContent({
        _tag: "assistant",
        text: "<proposed_plan>  </proposed_plan>",
      }),
    ).toBeNull();
  });

  it("returns the newest complete plan in a transcript", () => {
    expect(
      latestProposedPlanMarkdown([
        {
          content: {
            _tag: "tool_use",
            tool: "ExitPlanMode",
            input: { plan: "First" },
          },
        },
        { content: { _tag: "assistant", text: "ordinary reply" } },
        {
          content: {
            _tag: "assistant",
            text: "<proposed_plan>Latest</proposed_plan>",
          },
        },
      ]),
    ).toBe("Latest");
  });

	it("recovers an unmarked historical plan from its approval handoff", () => {
		expect(
			latestProposedPlanMarkdown([
				{ content: { _tag: "user", text: "Plan this change" } },
				{
					content: { _tag: "assistant", text: "# Historical plan\n\nShip it." },
				},
				{ content: { _tag: "user", text: PLAN_APPROVAL_PROMPT } },
				{ content: { _tag: "assistant", text: "Implementation complete." } },
			]),
		).toBe("# Historical plan\n\nShip it.");
	});
});
