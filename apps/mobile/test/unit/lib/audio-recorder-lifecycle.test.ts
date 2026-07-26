import { describe, expect, it, vi } from "vitest";

import { stopRecorderOnUnmount } from "~/lib/audio-recorder-lifecycle";

describe("audio recorder lifecycle", () => {
	it("does not read native state after the recorder shared object is released", async () => {
		const stop = vi
			.fn<() => Promise<void>>()
			.mockRejectedValue(new Error("native object released"));
		const recorder = {
			get isRecording(): boolean {
				throw new Error("native object released");
			},
			stop,
		};

		await expect(stopRecorderOnUnmount(recorder)).resolves.toBeUndefined();
	});
});
