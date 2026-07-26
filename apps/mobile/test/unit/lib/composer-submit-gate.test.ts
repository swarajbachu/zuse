import { describe, expect, test } from "vitest";

import { createComposerSubmitGate } from "../../../src/lib/composer-submit-gate";

describe("composer submit gate", () => {
	test("admits only one submission until the active receipt settles", async () => {
		const gate = createComposerSubmitGate();
		let release!: () => void;
		const receipt = new Promise<void>((resolve) => {
			release = resolve;
		});

		expect(gate.tryRun(() => receipt)).not.toBeNull();
		expect(gate.tryRun(async () => undefined)).toBeNull();

		release();
		await receipt;
		await Promise.resolve();

		expect(gate.tryRun(async () => undefined)).not.toBeNull();
	});
});
