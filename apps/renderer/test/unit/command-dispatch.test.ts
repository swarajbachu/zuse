import { expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../../src/lib/command-handlers.ts", () => ({
	dispatchCommand: (command: string) => calls.push(command),
}));

import { dispatchCommand } from "../../src/lib/commands.ts";

it("delivers commands once and in order across initial handler loading", async () => {
	dispatchCommand("next-tab");
	dispatchCommand("prev-tab");
	await vi.waitFor(() => expect(calls).toEqual(["next-tab", "prev-tab"]));
	dispatchCommand("settings");
	expect(calls).toEqual(["next-tab", "prev-tab", "settings"]);
});
