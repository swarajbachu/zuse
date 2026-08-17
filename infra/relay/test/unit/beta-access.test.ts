import { analyticsAccountId } from "@zuse/analytics/identity";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
	BetaAccess,
	BetaAccessDenied,
	BetaAccessUnavailable,
	makePostHogBetaAccess,
	requireCloudBetaAccess,
} from "../../src/beta-access.ts";

const config = {
	host: "https://us.i.posthog.com",
	projectToken: "phc_test",
	flagKey: "zuse-cloud-beta-access",
};

const response = (body: unknown, status = 200) =>
	Promise.resolve(
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);

describe("cloud beta access", () => {
	test("evaluates only the configured flag with the verified account id", async () => {
		let body: unknown;
		const access = makePostHogBetaAccess(config, (_url, init) => {
			body = JSON.parse(String(init?.body));
			return response({
				flags: {
					"zuse-cloud-beta-access": { enabled: true },
				},
			});
		});

		await expect(
			Effect.runPromise(access.check("user_verified")),
		).resolves.toBe(undefined);
		expect(body).toMatchObject({
			distinct_id: analyticsAccountId("user_verified"),
			person_properties: { workos_account_id: "user_verified" },
			flag_keys_to_evaluate: ["zuse-cloud-beta-access"],
			geoip_disable: true,
		});
	});

	test("denies an absent or disabled flag", async () => {
		for (const flags of [
			{},
			{ "zuse-cloud-beta-access": { enabled: false } },
		]) {
			const access = makePostHogBetaAccess(config, () => response({ flags }));
			await expect(
				Effect.runPromise(access.check("user_denied")),
			).rejects.toBeInstanceOf(BetaAccessDenied);
		}
	});

	test("fails closed when evaluation is unavailable or invalid", async () => {
		const fetchers: Array<typeof fetch> = [
			() => Promise.reject(new Error("offline")),
			() => response({ flags: {} }, 503),
			() => response({ invalid: true }),
			() =>
				response({
					flags: { "zuse-cloud-beta-access": { enabled: true } },
					errorsWhileComputingFlags: true,
				}),
			() =>
				response({
					flags: { "zuse-cloud-beta-access": { enabled: true } },
					quotaLimited: ["feature_flags"],
				}),
		];
		for (const fetcher of fetchers) {
			const access = makePostHogBetaAccess(config, fetcher);
			await expect(
				Effect.runPromise(access.check("user_fail_closed")),
			).rejects.toBeInstanceOf(BetaAccessUnavailable);
		}
		const timeout = makePostHogBetaAccess(
			{ ...config, timeoutMs: 1 },
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);
		await expect(
			Effect.runPromise(timeout.check("user_timeout")),
		).rejects.toBeInstanceOf(BetaAccessUnavailable);
	});

	test("maps a PostHog outage to the stable 503 relay contract", async () => {
		const result = await Effect.runPromise(
			requireCloudBetaAccess("user_unavailable").pipe(
				Effect.flip,
				Effect.provideService(
					BetaAccess,
					BetaAccess.of({
						check: () => Effect.fail(new BetaAccessUnavailable()),
					}),
				),
			),
		);
		expect(result).toMatchObject({
			status: 503,
			code: "cloud_beta_access_unavailable",
		});
	});
});
