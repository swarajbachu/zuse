import { ApiPaths, type EnvironmentId, type SessionId } from "@zuse/contracts";
import { Context, Data, Effect, Layer } from "effect";

import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";

export type ApiActivityKind =
	| "approval-needed"
	| "question-needed"
	| "completed"
	| "error"
	| "running";

export class ApiActivityPublishError extends Data.TaggedError(
	"ApiActivityPublishError",
)<{
	readonly reason: string;
}> {}

export interface ApiActivityPublisherApi {
	readonly publish: (input: {
		readonly sessionId: SessionId;
		readonly kind: ApiActivityKind;
	}) => Effect.Effect<void, ApiActivityPublishError>;
}

export class ApiActivityPublisher extends Context.Service<
	ApiActivityPublisher,
	ApiActivityPublisherApi
>()("zuse/ApiActivityPublisher") {}

const fail = (cause: unknown) =>
	new ApiActivityPublishError({
		reason: cause instanceof Error ? cause.message : String(cause),
	});

export const ApiActivityPublisherLive: Layer.Layer<
	ApiActivityPublisher,
	never,
	LanAuthService
> = Layer.effect(
	ApiActivityPublisher,
	Effect.gen(function* () {
		const lanAuth = yield* LanAuthService;

		return ApiActivityPublisher.of({
			publish: (input) =>
				Effect.gen(function* () {
					const config = yield* lanAuth
						.getApiConfig()
						.pipe(Effect.mapError((error) => fail(error.reason)));
					if (config === null) return;

					yield* Effect.tryPromise({
						try: async () => {
							const response = await fetch(
								`${config.apiUrl}${ApiPaths.agentActivity(
									config.environmentId as EnvironmentId,
								)}`,
								{
									method: "POST",
									headers: {
										authorization: `Bearer ${config.environmentCredential}`,
										"content-type": "application/json",
									},
									body: JSON.stringify({
										sessionId: input.sessionId,
										kind: input.kind,
										...(config.label === undefined
											? {}
											: { title: config.label }),
									}),
								},
							);
							if (!response.ok) {
								throw new Error(`api_activity_${response.status}`);
							}
						},
						catch: fail,
					});
				}),
		});
	}),
);
