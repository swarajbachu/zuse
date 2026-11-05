import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { launchWithFallback } from "../../src/automation/cloud-launcher.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.runPromise(Effect.result(effect));

describe("automation cloud provider fallback", () => {
	it("moves to the next provider only when a provider is unavailable", async () => {
		const tried: string[] = [];
		const result = await run(
			launchWithFallback(["e2b", "box", "boxd"], (providerId) => {
				tried.push(providerId);
				return providerId === "box"
					? Effect.succeed(providerId)
					: Effect.fail({
							providerSpecific: true,
							reason: `${providerId} is unavailable right now.`,
						});
			}),
		);
		expect(tried).toEqual(["e2b", "box"]);
		expect(result).toMatchObject({ _tag: "Success", success: "box" });
	});
	it("stops on account-wide failures and reports every reason", async () => {
		const tried: string[] = [];
		const result = await run(
			launchWithFallback(["e2b", "box"], (providerId) => {
				tried.push(providerId);
				return Effect.fail({
					providerSpecific: providerId === "e2b",
					reason:
						providerId === "e2b"
							? "E2B is unavailable right now."
							: "Cloud billing is on hold.",
				});
			}),
		);
		expect(tried).toEqual(["e2b", "box"]);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure")
			expect(result.failure.message).toBe(
				"E2B is unavailable right now. Cloud billing is on hold.",
			);
	});
	it("fails without trying others when fallback is off", async () => {
		const tried: string[] = [];
		const result = await run(
			launchWithFallback(["e2b"], (providerId) => {
				tried.push(providerId);
				return Effect.fail({ providerSpecific: true, reason: "down" });
			}),
		);
		expect(tried).toEqual(["e2b"]);
		expect(result._tag).toBe("Failure");
	});
});
