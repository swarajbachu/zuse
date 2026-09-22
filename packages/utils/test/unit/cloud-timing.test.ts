import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { measureCloudStage } from "../../src/cloud-timing.ts";

test("records failure duration without exposing the error or changing the outcome", async () => {
	const log = vi.spyOn(console, "info").mockImplementation(() => {});
	try {
		const secretError = { token: "must-not-be-logged" };
		const result = await Effect.runPromise(
			Effect.fail(secretError).pipe(
				measureCloudStage({ workspaceId: "workspace-test" }, "bootstrap"),
				Effect.exit,
			),
		);
		expect(result._tag).toBe("Failure");
		expect(log.mock.calls).toHaveLength(2);
		expect(log.mock.calls[1]?.[1]).toMatchObject({
			stage: "bootstrap",
			event: "end",
			outcome: "Failure",
			durationMs: expect.any(Number),
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain("must-not-be-logged");
	} finally {
		log.mockRestore();
	}
});
