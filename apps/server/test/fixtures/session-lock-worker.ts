import { Deferred, Effect, ManagedRuntime } from "effect";
import { SessionStoreLive } from "../../src/auth/layers/session-store.ts";
import { SessionStore } from "../../src/auth/services/session-store.ts";

const release = Deferred.makeUnsafe<void>();
process.on("message", () =>
	Effect.runSync(Deferred.succeed(release, undefined)),
);
const runtime = ManagedRuntime.make(SessionStoreLive);
try {
	process.send?.("ready");
	await runtime.runPromise(
		Effect.flatMap(SessionStore, (store) =>
			store.withLock(
				Effect.promise(async () => {
					process.send?.("entered");
					await Effect.runPromise(Deferred.await(release));
				}),
			),
		),
	);
} finally {
	await runtime.dispose();
	process.disconnect?.();
}
