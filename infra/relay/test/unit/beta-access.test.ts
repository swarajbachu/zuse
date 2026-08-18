import { analyticsAccountId } from "@zuse/analytics/identity";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
	BetaAccess,
	BetaAccessDenied,
	BetaAccessUnavailable,
	ensureCloudBetaAccess,
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

const decisionCache = () => {
	const values = new Map<string, Response>();
	return {
		match: (request: RequestInfo | URL) =>
			Promise.resolve(values.get(String(request))?.clone()),
		put: (request: RequestInfo | URL, response: Response) => {
			values.set(String(request), response.clone());
			return Promise.resolve();
		},
	};
};

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

	test("shares one short-lived decision across relay requests", async () => {
		const cache = decisionCache();
		let evaluations = 0;
		const fetcher = () => {
			evaluations += 1;
			return response({
				flags: { "zuse-cloud-beta-access": { enabled: true } },
			});
		};
		await Effect.runPromise(
			makePostHogBetaAccess({ ...config, cache }, fetcher).check("user_cached"),
		);
		await Effect.runPromise(
			makePostHogBetaAccess({ ...config, cache }, fetcher).check("user_cached"),
		);
		expect(evaluations).toBe(1);
	});

	test("enrolls a verified account and makes access immediate", async () => {
		const cache = decisionCache();
		let request: { readonly url: string; readonly body: unknown } | undefined;
		const access = makePostHogBetaAccess({ ...config, cache }, (url, init) => {
			request = {
				url: String(url),
				body: JSON.parse(String(init?.body)),
			};
			return response({ status: 1 });
		});

		await Effect.runPromise(access.grant("user_paid"));
		await expect(Effect.runPromise(access.check("user_paid"))).resolves.toBe(
			undefined,
		);
		expect(request).toEqual({
			url: "https://us.i.posthog.com/capture/",
			body: {
				api_key: "phc_test",
				event: "$identify",
				properties: {
					distinct_id: analyticsAccountId("user_paid"),
					$set: {
						workos_account_id: "user_paid",
						zuse_cloud_beta_access: true,
					},
				},
			},
		});
	});

	test("does not re-enroll an account that already has access", async () => {
		let grants = 0;
		await Effect.runPromise(
			ensureCloudBetaAccess("user_allowed").pipe(
				Effect.provideService(
					BetaAccess,
					BetaAccess.of({
						check: () => Effect.void,
						grant: () =>
							Effect.sync(() => {
								grants += 1;
							}),
					}),
				),
			),
		);
		expect(grants).toBe(0);
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
						grant: () => Effect.fail(new BetaAccessUnavailable()),
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
