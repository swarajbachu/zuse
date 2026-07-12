import { chmodSync, copyFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, URL as NodeUrl } from "node:url";
import { installHermeticProcessPath } from "./fake-acp.ts";

export type FakeSdkPeer<A> = {
	readonly events: AsyncIterable<A>;
	readonly push: (event: A) => void;
	readonly complete: () => void;
};

export const makeFakeSdkPeer = <A>(): FakeSdkPeer<A> => {
	const queued: Array<A> = [];
	const waiters: Array<(value: IteratorResult<A>) => void> = [];
	let completed = false;
	const next = (): Promise<IteratorResult<A>> => {
		if (queued.length > 0) {
			return Promise.resolve({ done: false, value: queued.shift() as A });
		}
		if (completed) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve) => waiters.push(resolve));
	};
	return {
		events: { [Symbol.asyncIterator]: () => ({ next }) },
		push: (event) => {
			if (completed)
				throw new Error("Cannot push to a completed fake SDK peer.");
			const waiter = waiters.shift();
			if (waiter === undefined) queued.push(event);
			else waiter({ done: false, value: event });
		},
		complete: () => {
			if (completed) return;
			completed = true;
			for (const waiter of waiters.splice(0)) {
				waiter({ done: true, value: undefined });
			}
		},
	};
};

export type FakeHttpProviderPeer = {
	readonly url: string;
	readonly requests: ReadonlyArray<{
		readonly method: string;
		readonly path: string;
		readonly body: string;
	}>;
	readonly close: () => Promise<void>;
};

export const startFakeHttpProviderPeer = async (
	response: unknown = { ok: true },
): Promise<FakeHttpProviderPeer> => {
	const requests: Array<{ method: string; path: string; body: string }> = [];
	const server = createServer((request, result) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			requests.push({
				method: request.method ?? "GET",
				path: request.url ?? "/",
				body,
			});
			result.writeHead(200, { "content-type": "application/json" });
			result.end(JSON.stringify(response));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("Fake HTTP provider did not bind a TCP port.");
	}
	let closed = false;
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => {
			if (closed) return Promise.resolve();
			closed = true;
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
};

const appServerFixture = fileURLToPath(
	new NodeUrl("../fixtures/fake-app-server-provider.mjs", import.meta.url),
);

export const keytarShimRequirePath = fileURLToPath(
	new NodeUrl("../fixtures/keytar-shim.cjs", import.meta.url),
);

export const installFakeAppServerProvider = (root: string): string => {
	const binDirectory = installHermeticProcessPath(root);
	const executable = join(binDirectory, "provider-app-server");
	copyFileSync(appServerFixture, executable);
	chmodSync(executable, 0o755);
	return executable;
};
