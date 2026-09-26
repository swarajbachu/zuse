import { CloudWorkspaceOpError } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import type { CloudControlRequest } from "./cloud-control-client.ts";
export const makeCloudControlRequest =
	(options: {
		token: () => Promise<string | null>;
		url: (path: string) => string;
		epoch?: () => unknown;
	}): CloudControlRequest =>
	(path, schema, method = "GET", body) =>
		Effect.gen(function* () {
			const epoch = options.epoch?.();
			const token = yield* Effect.tryPromise({
				try: options.token,
				catch: () => new CloudWorkspaceOpError({ code: "not-allowed" }),
			});
			if (token === null || epoch !== options.epoch?.())
				return yield* Effect.fail(
					new CloudWorkspaceOpError({ code: "not-allowed" }),
				);
			const response = yield* Effect.tryPromise({
				try: (signal) =>
					fetch(options.url(path), {
						method,
						signal,
						headers: {
							authorization: `Bearer ${token}`,
							...(body === undefined
								? {}
								: { "content-type": "application/json" }),
						},
						body: body === undefined ? undefined : JSON.stringify(body),
					}),
				catch: () =>
					new CloudWorkspaceOpError({ code: "provider-unavailable" }),
			});
			if (token === null || epoch !== options.epoch?.())
				return yield* Effect.fail(
					new CloudWorkspaceOpError({ code: "not-allowed" }),
				);
			const payload: unknown = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: () =>
					new CloudWorkspaceOpError({ code: "provider-unavailable" }),
			}).pipe(
				Effect.catch((cause) =>
					response.ok ? Effect.fail(cause) : Effect.succeed(null),
				),
			);
			if (!response.ok) {
				const error =
					typeof payload === "object" && payload !== null
						? (Reflect.get(payload, "error") ?? Reflect.get(payload, "code"))
						: null;
				const codes: Record<string, CloudWorkspaceOpError["code"]> = {
					cloud_beta_access_required: "beta-access-required",
					cloud_beta_access_unavailable: "beta-access-unavailable",
					cloud_entitlement_required: "entitlement-required",
					cloud_credential_connection_required: "credential-required",
					cloud_project_not_ready: "project-not-ready",
					cloud_image_rebuild_required: "project-not-ready",
					billing_hold: "billing-hold",
					entitlement_required: "entitlement-required",
					billing_approval_pending: "billing-hold",
				};
				return yield* Effect.fail(
					new CloudWorkspaceOpError({
						code:
							(typeof error === "string" ? codes[error] : undefined) ??
							(response.status === 401 || response.status === 403
								? "not-allowed"
								: response.status === 404
									? "not-found"
									: response.status === 409
										? "conflict"
										: response.status >= 500 || response.status === 429
											? "provider-unavailable"
											: "invalid-request"),
					}),
				);
			}
			return yield* Schema.decodeUnknownEffect(schema)(payload).pipe(
				Effect.mapError(
					() => new CloudWorkspaceOpError({ code: "invalid-request" }),
				),
			);
		});
