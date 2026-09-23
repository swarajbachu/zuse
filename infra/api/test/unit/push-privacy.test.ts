import { Effect } from "effect";
import { expect, test } from "vitest";
import { makePushDeliveryLayer, PushDelivery } from "../../src/push";

test("push payloads never expose an environment label", async () => {
	let payload: unknown;
	const fetchImpl: typeof fetch = async (_url, init) => {
		payload = JSON.parse(String(init?.body));
		return new Response("{}", { status: 200 });
	};
	await Effect.runPromise(
		Effect.gen(function* () {
			const push = yield* PushDelivery;
			yield* push.send([
				{
					to: "push-token",
					environmentId: "env_1",
					kind: "approval-needed",
					title: "Private customer project",
					target: "zuse:///",
				},
			]);
		}).pipe(Effect.provide(makePushDeliveryLayer(fetchImpl))),
	);
	expect(payload).toEqual([
		{
			to: "push-token",
			sound: "default",
			title: "Zuse",
			body: "Approval needed",
			data: {
				environmentId: "env_1",
				kind: "approval-needed",
				target: "zuse:///",
			},
		},
	]);
	expect(JSON.stringify(payload)).not.toContain("Private customer");
});
