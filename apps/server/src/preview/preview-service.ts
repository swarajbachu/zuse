import { Socket } from "node:net";
import type {
	PreviewErrorCode,
	PreviewForwardResult,
	PreviewServer,
} from "@zuse/contracts";
import {
	isTailnetOperatorPermissionError,
	parseTailnetStatus,
	runTailnetCommand,
	type TailnetCommandRunner,
} from "@zuse/tailnet";
import {
	type LocalServerSummary,
	listLocalServers,
} from "@zuse/utils/local-port-inspector";
import { Context, Effect, Layer } from "effect";

const MINIMUM_PREVIEW_PORT = 1_024;
const HTTP_PROBE_TIMEOUT_MS = 1_000;
const HTTP_RESPONSE_PREFIX_LENGTH = "HTTP/".length;

export class PreviewServiceError {
	readonly _tag = "PreviewServiceError";

	constructor(
		readonly code: PreviewErrorCode,
		readonly approvalUrl?: string,
	) {}
}

export interface PreviewServiceShape {
	readonly listServers: () => Effect.Effect<
		ReadonlyArray<PreviewServer>,
		PreviewServiceError
	>;
	readonly forward: (
		port: number,
	) => Effect.Effect<PreviewForwardResult, PreviewServiceError>;
}

export class PreviewService extends Context.Service<
	PreviewService,
	PreviewServiceShape
>()("zuse/PreviewService") {}

export interface PreviewServiceDependencies {
	readonly listListeners: () => Promise<ReadonlyArray<LocalServerSummary>>;
	readonly probeHttp: (port: number) => Promise<boolean>;
	readonly runTailnet: TailnetCommandRunner;
	readonly zusePort: number;
}

const isAllowedPreviewPort = (port: number, zusePort: number): boolean =>
	Number.isInteger(port) &&
	port >= MINIMUM_PREVIEW_PORT &&
	port <= 65_535 &&
	port !== zusePort;

export const probeLoopbackHttp = async (port: number): Promise<boolean> => {
	return new Promise<boolean>((resolve) => {
		const socket = new Socket();
		let settled = false;
		let responsePrefix = "";
		const timeout = setTimeout(() => finish(false), HTTP_PROBE_TIMEOUT_MS);
		const finish = (http: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			resolve(http);
		};

		socket.once("error", () => finish(false));
		socket.once("close", () => finish(false));
		socket.on("data", (chunk: Buffer) => {
			responsePrefix += chunk.toString("latin1");
			if (responsePrefix.length >= HTTP_RESPONSE_PREFIX_LENGTH) {
				finish(responsePrefix.startsWith("HTTP/"));
			}
		});
		socket.once("connect", () => {
			socket.write(
				"OPTIONS * HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
			);
		});
		socket.connect(port, "127.0.0.1");
	});
};

const safePreviewServers = async (
	dependencies: PreviewServiceDependencies,
): Promise<ReadonlyArray<PreviewServer>> => {
	const listeners = (await dependencies.listListeners()).filter((server) =>
		isAllowedPreviewPort(server.port, dependencies.zusePort),
	);
	const probes = await Promise.all(
		listeners.map(async (server) => ({
			server,
			http: await dependencies.probeHttp(server.port),
		})),
	);
	return probes
		.filter((result) => result.http)
		.map(({ server }) => ({ name: server.name, port: server.port }));
};

export const makePreviewService = (
	dependencies: PreviewServiceDependencies,
): PreviewServiceShape => {
	let commandTail = Promise.resolve();
	const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
		const result = commandTail.then(operation, operation);
		commandTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	return PreviewService.of({
		listServers: () =>
			Effect.tryPromise({
				try: () => safePreviewServers(dependencies),
				catch: () => new PreviewServiceError("preview-unavailable"),
			}),
		forward: (port) =>
			Effect.tryPromise({
				try: () =>
					exclusive(async () => {
						if (!isAllowedPreviewPort(port, dependencies.zusePort)) {
							throw new PreviewServiceError("invalid-port");
						}
						const listeners = await dependencies.listListeners();
						if (!listeners.some((server) => server.port === port)) {
							throw new PreviewServiceError("server-not-found");
						}
						if (!(await dependencies.probeHttp(port))) {
							throw new PreviewServiceError("server-not-http");
						}

						const status = await dependencies.runTailnet(["status", "--json"]);
						if (status.code !== 0) {
							throw new PreviewServiceError("private-network-required");
						}
						const parsed = parseTailnetStatus(status.stdout);
						if (parsed.backendState !== "Running" || parsed.dnsName === null) {
							throw new PreviewServiceError("private-network-required");
						}

						const served = await dependencies.runTailnet(
							[
								"serve",
								"--bg",
								"--yes",
								`--https=${port}`,
								`http://127.0.0.1:${port}`,
							],
							15_000,
						);
						if (served.approvalUrl !== undefined) {
							throw new PreviewServiceError(
								"private-preview-approval-required",
								served.approvalUrl,
							);
						}
						if (served.code !== 0) {
							const output = `${served.stderr}\n${served.stdout}`;
							throw new PreviewServiceError(
								isTailnetOperatorPermissionError(output)
									? "private-network-permission-required"
									: "preview-unavailable",
							);
						}

						return {
							port,
							url: `https://${parsed.dnsName}:${port}`,
							transport: "private-network" as const,
						};
					}),
				catch: (cause) =>
					cause instanceof PreviewServiceError
						? cause
						: new PreviewServiceError("preview-unavailable"),
			}),
	});
};

export const PreviewServiceLive: Layer.Layer<PreviewService> = Layer.succeed(
	PreviewService,
	makePreviewService({
		listListeners: listLocalServers,
		probeHttp: probeLoopbackHttp,
		runTailnet: runTailnetCommand,
		zusePort: Number(process.env.ZUSE_PORT ?? "47837"),
	}),
);
