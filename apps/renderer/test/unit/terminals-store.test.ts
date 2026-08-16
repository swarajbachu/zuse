import { type ChatId, EnvironmentId } from "@zuse/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { terminalsKey, useTerminalsStore } from "../../src/store/terminals.ts";

describe("qualified terminals store", () => {
	beforeEach(() => {
		useTerminalsStore.setState({ byKey: {} });
	});

	it("isolates equal chat ids across environments", () => {
		const chatId = "same-chat" as ChatId;
		const first = { environmentId: EnvironmentId.make("computer-a"), chatId };
		const second = { environmentId: EnvironmentId.make("computer-b"), chatId };
		const store = useTerminalsStore.getState();

		const terminalA = store.ensureSlot(first, 0, "/workspace/a");
		const terminalB = store.ensureSlot(second, 0, "/workspace/b");

		expect(terminalsKey(first)).not.toBe(terminalsKey(second));
		expect(terminalA.environmentId).toBe(first.environmentId);
		expect(terminalB.environmentId).toBe(second.environmentId);
		expect(terminalA.id).not.toBe(terminalB.id);
		expect(useTerminalsStore.getState().byKey[terminalsKey(first)]).toEqual([
			terminalA,
		]);
		expect(useTerminalsStore.getState().byKey[terminalsKey(second)]).toEqual([
			terminalB,
		]);
	});

	it("keeps a local shell owned by its cloud chat", () => {
		const ref = {
			environmentId: EnvironmentId.make("cloud-workspace"),
			chatId: "cloud-chat" as ChatId,
		};
		const localEnvironmentId = EnvironmentId.make("desktop");
		const store = useTerminalsStore.getState();

		const slot = store.add(
			ref,
			localEnvironmentId,
			"/Users/me/.zuse/cloud/repo/branch",
			"Local",
		);
		const terminal =
			useTerminalsStore.getState().byKey[terminalsKey(ref)]?.[slot];

		expect(terminal?.environmentId).toBe(localEnvironmentId);
		expect(terminal?.cwd).toBe("/Users/me/.zuse/cloud/repo/branch");
		expect(store.ensureSlot(ref, slot, "/home/zuse/workspace")).toBe(terminal);
	});
});
