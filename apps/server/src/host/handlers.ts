import { HostHandoffUnavailableError, MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { SessionService } from "../conversation/services/conversation-services.ts";
import { LanAuthConfig } from "../lan-auth/services/lan-auth-service.ts";

const HostOpenSession = MemoizeRpcs.toLayerHandler(
	"host.openSession",
	({ sessionId }) =>
		Effect.gen(function* () {
			const config = yield* LanAuthConfig;
			if (config.openHostSession === undefined) {
				return yield* Effect.fail(
					new HostHandoffUnavailableError({
						reason: "This environment has no interactive desktop host.",
					}),
				);
			}
			const sessions = yield* SessionService;
			const session = yield* sessions.getSession(sessionId).pipe(
				Effect.mapError(
					() =>
						new HostHandoffUnavailableError({
							reason: "The requested session no longer exists.",
						}),
				),
			);
			yield* Effect.tryPromise({
				try: () =>
					Promise.resolve(config.openHostSession?.(sessionId, session.chatId)),
				catch: () =>
					new HostHandoffUnavailableError({
						reason: "The desktop could not open this session.",
					}),
			});
		}),
);

export const HostHandlersLayer = Layer.mergeAll(HostOpenSession);
