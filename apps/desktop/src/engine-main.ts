import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import { CredentialsServiceLive } from "@zusehq/server";
import {
	readDesktopEngineConfig,
	runDesktopEngine,
} from "@zusehq/server/desktop-engine/runtime";
import { secureStorageMasterKey } from "@zusehq/server/secure-storage-master-key";
import { Effect } from "effect";
import { ComputerAwakeController } from "./computer-awake-controller.ts";
import {
	readComputerAwakePreference,
	watchComputerAwakePreference,
} from "./computer-awake-preference.ts";
import { verifyEngineBuild } from "./engine-build-id.ts";
import { createLocalConnectivity } from "./local-connectivity.ts";

const boot = Effect.gen(function* () {
	const path = process.argv[2];
	if (path === undefined)
		return yield* Effect.fail(
			new Error("Missing private engine configuration path."),
		);
	const config = yield* Effect.tryPromise(() => readDesktopEngineConfig(path));
	const supervisorPath = join(
		dirname(process.argv[1] ?? path),
		"engine-supervisor.cjs",
	);
	yield* Effect.tryPromise(() =>
		verifyEngineBuild(config.buildId, supervisorPath),
	);
	const connectivity = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createLocalConnectivity({
				helperPath: config.nearbyHelperPath,
				serviceName: hostname(),
				log: (event, fields) =>
					console.info(JSON.stringify({ event, ...fields })),
			}),
		),
		(value) => Effect.promise(() => value.close()),
	);
	process.env.ZUSE_APP_VERSION = config.appVersion;
	const initialMode = yield* Effect.promise(() =>
		readComputerAwakePreference(config.userData),
	);
	const awake = yield* Effect.acquireRelease(
		Effect.sync(() => new ComputerAwakeController({ initialMode })),
		(controller) => Effect.sync(() => controller.dispose()),
	);
	if (process.platform === "darwin")
		yield* Effect.acquireRelease(
			Effect.sync(() =>
				watchComputerAwakePreference(config.userData, (mode) =>
					awake.setMode(mode),
				),
			),
			(stop) => Effect.sync(stop),
		);
	let remoteClients = 0;
	yield* runDesktopEngine(config, {
		credentialsLayer: CredentialsServiceLive,
		modelConnectionMasterKey: secureStorageMasterKey,
		onNearbyListening: (port, pin) => connectivity.start(port, pin),
		subscribeComputerAwakeStatus: (listener) => awake.subscribe(listener),
		onActiveTurns: (count) => awake.setActiveAgents(count),
		onRemoteConnection: () => {
			awake.setRemoteClients(++remoteClients);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				awake.setRemoteClients(--remoteClients);
			};
		},
	});
});

const supervisorDisconnected = () => process.kill(process.pid, "SIGTERM");
if (process.send !== undefined)
	process.once("disconnect", supervisorDisconnected);
NodeRuntime.runMain(
	Effect.scoped(boot).pipe(
		Effect.onExit(() =>
			Effect.sync(() => {
				process.off("disconnect", supervisorDisconnected);
				if (process.connected) process.disconnect();
			}),
		),
	),
);
