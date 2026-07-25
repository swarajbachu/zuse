import { CodexAppServerClient } from "@zuse/agents/drivers/codex-app-server-client";

type StartOptions = Parameters<typeof CodexAppServerClient.start>[0];
type NotificationHandler = StartOptions["onNotification"];

export interface CodexAuxiliaryConnection {
	readonly isClosed: boolean;
	readonly request: CodexAppServerClient["request"];
	readonly close: () => void;
}

interface PoolOptions {
	readonly start: (options: StartOptions) => Promise<CodexAuxiliaryConnection>;
	readonly idleTimeoutMs: number;
}

export interface CodexAuxiliaryRequestOptions {
	readonly codexPath: string | null;
	readonly startupTimeoutMs?: number;
	readonly onNotification?: NotificationHandler;
}

export interface CodexAuxiliaryAppServerPool {
	readonly withClient: <A>(
		options: CodexAuxiliaryRequestOptions,
		run: (client: CodexAuxiliaryConnection) => Promise<A>,
	) => Promise<A>;
	readonly shutdown: () => Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Owns the single short-lived Codex process used by server-side metadata
 * features. A Codex app-server refreshes its model catalog during initialize,
 * so starting one process per feature creates an avoidable request burst.
 *
 * Live agent sessions intentionally do not use this pool: their notification
 * and permission lifecycles belong to the session driver.
 */
export const createCodexAuxiliaryAppServerPool = ({
	start,
	idleTimeoutMs,
}: PoolOptions): CodexAuxiliaryAppServerPool => {
	let client: CodexAuxiliaryConnection | null = null;
	let starting: Promise<CodexAuxiliaryConnection> | null = null;
	let activeOperations = 0;
	let idleTimer: NodeJS.Timeout | null = null;
	const notificationHandlers = new Map<NotificationHandler, number>();

	const clearIdleTimer = (): void => {
		if (idleTimer === null) return;
		clearTimeout(idleTimer);
		idleTimer = null;
	};

	const discardClient = (candidate: CodexAuxiliaryConnection): void => {
		if (client !== candidate) return;
		client = null;
		starting = null;
		candidate.close();
	};

	const closeIdleClient = (): void => {
		idleTimer = null;
		if (activeOperations > 0 || client === null) return;
		discardClient(client);
	};

	const scheduleIdleClose = (): void => {
		if (activeOperations > 0 || client === null || idleTimer !== null) return;
		idleTimer = setTimeout(closeIdleClient, idleTimeoutMs);
		idleTimer.unref?.();
	};

	const getOrStart = async (
		options: CodexAuxiliaryRequestOptions,
	): Promise<CodexAuxiliaryConnection> => {
		if (client?.isClosed === true) {
			client = null;
			starting = null;
		}
		if (client !== null) return client;
		if (starting !== null) return starting;

		const pending = start({
			codexPath: options.codexPath,
			startupTimeoutMs: options.startupTimeoutMs,
			onNotification: (notification) => {
				for (const handler of notificationHandlers.keys()) {
					try {
						handler(notification);
					} catch {
						// Metadata notifications are best-effort. One feature must
						// not prevent another feature from receiving its event.
					}
				}
			},
			onServerRequest: (_request, respond) => respond({}),
		});
		starting = pending;
		try {
			const started = await pending;
			if (starting === pending) client = started;
			return started;
		} catch (cause) {
			if (starting === pending) starting = null;
			throw cause;
		}
	};

	const withClient: CodexAuxiliaryAppServerPool["withClient"] = async (
		options,
		run,
	) => {
		clearIdleTimer();
		activeOperations += 1;
		const handler = options.onNotification;
		if (handler !== undefined) {
			notificationHandlers.set(
				handler,
				(notificationHandlers.get(handler) ?? 0) + 1,
			);
		}
		let acquired: CodexAuxiliaryConnection | null = null;
		try {
			acquired = await getOrStart(options);
			return await run(acquired);
		} finally {
			if (handler !== undefined) {
				const remaining = (notificationHandlers.get(handler) ?? 1) - 1;
				if (remaining === 0) notificationHandlers.delete(handler);
				else notificationHandlers.set(handler, remaining);
			}
			activeOperations -= 1;
			if (acquired?.isClosed === true) discardClient(acquired);
			scheduleIdleClose();
		}
	};

	const shutdown = async (): Promise<void> => {
		clearIdleTimer();
		const pending = starting;
		const current = client;
		client = null;
		starting = null;
		if (current !== null) {
			current.close();
			return;
		}
		if (pending === null) return;
		try {
			(await pending).close();
		} catch {
			// A failed startup has no child left to close.
		}
	};

	return { withClient, shutdown };
};

const sharedPool = createCodexAuxiliaryAppServerPool({
	start: CodexAppServerClient.start,
	idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
});

export const withCodexAuxiliaryAppServer = sharedPool.withClient;

export const shutdownCodexAuxiliaryAppServer = sharedPool.shutdown;
