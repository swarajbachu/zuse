import { AgentItemId } from "@zuse/contracts";
import { expect, test } from "vitest";
import { maskProviderEvent } from "../../src/environment/mask-provider-event.ts";

test("partial cumulative checkpoints never expose a secret prefix", () => {
	const itemId = AgentItemId.make("item-1");
	for (let length = 1; length <= 10; length++) {
		const text = `value: ${"secret-key".slice(0, length)}`;
		const event = maskProviderEvent(
			{
				_tag: "AssistantMessage",
				itemId,
				text,
				checkpoint: { revision: length, final: false },
			},
			["secret-key"],
		);
		expect("text" in event && event.text).toBe(
			length < 10 ? "value: " : "value: [secret]",
		);
	}
});
test("tool inputs and results are masked without changing item IDs", () => {
	const itemId = AgentItemId.make("item-1");
	const event = maskProviderEvent(
		{
			_tag: "ToolResult",
			itemId,
			output: { data: ["private-value"] },
			isError: false,
		},
		["private-value"],
	);
	expect(event).toEqual({
		_tag: "ToolResult",
		itemId,
		output: { data: ["[secret]"] },
		isError: false,
	});
});
