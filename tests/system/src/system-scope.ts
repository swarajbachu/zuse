import { join } from "node:path";
import type { ClientSession } from "@zuse/client-runtime/connection";
import {
	type FakeAcpController,
	makeTemporaryDirectory,
	startFakeAcpController,
	startHeadlessServer,
	withResourceScope,
} from "@zuse/testkit";
import {
	connectDroppableSystemRpc,
	connectSystemRpc,
	type SystemRpcClient,
} from "./rpc-client.ts";

type HeadlessOptions = Omit<
	NonNullable<Parameters<typeof startHeadlessServer>[0]>,
	"root"
>;

export type SystemTestScope = {
	readonly root: string;
	readonly path: (...segments: ReadonlyArray<string>) => string;
	readonly defer: (release: () => Promise<void> | void) => void;
	readonly acquire: <A>(
		acquire: () => Promise<A> | A,
		release: (resource: A) => Promise<void> | void,
	) => Promise<A>;
	readonly controller: () => Promise<FakeAcpController>;
	readonly server: (
		options?: HeadlessOptions,
	) => ReturnType<typeof startHeadlessServer>;
	readonly rpc: (endpoint: string) => Promise<ClientSession<SystemRpcClient>>;
	readonly droppableRpc: (
		endpoint: string,
	) => ReturnType<typeof connectDroppableSystemRpc>;
};

export const withSystemTest = <A>(
	prefix: string,
	run: (scope: SystemTestScope) => Promise<A>,
): Promise<A> =>
	withResourceScope(async (resources) => {
		const temporary = await resources.acquire(
			() => makeTemporaryDirectory(prefix),
			(value) => value.dispose(),
		);
		return run({
			root: temporary.path,
			path: (...segments) => join(temporary.path, ...segments),
			defer: resources.defer,
			acquire: resources.acquire,
			controller: () =>
				resources.acquire(startFakeAcpController, (value) => value.close()),
			server: (options) =>
				resources.acquire(
					() => startHeadlessServer({ root: temporary.path, ...options }),
					(value) => value.stop(),
				),
			rpc: (endpoint) =>
				resources.acquire(
					() => connectSystemRpc(endpoint),
					(value) => value.dispose(),
				),
			droppableRpc: (endpoint) =>
				resources.acquire(
					() => connectDroppableSystemRpc(endpoint),
					(value) => value.dispose(),
				),
		});
	});
