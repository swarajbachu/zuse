import { Option, Schema } from "effect";

const SessionResult = Schema.Struct({ sessionId: Schema.String });
const decodeSessionResult = Schema.decodeUnknownOption(SessionResult);

export interface CreateAcpSessionOptions {
	readonly request: (method: string, params: unknown) => Promise<unknown>;
	readonly cwd: string;
	readonly sessionId: string;
	readonly providerLabel: string;
	readonly httpServers: ReadonlyArray<unknown>;
	readonly fallbackServers?: () => Promise<ReadonlyArray<unknown>>;
	readonly providerEventCursor?: string | null;
	readonly resumeCursor?: string | null;
	readonly shouldReplaceMissingSession?: (cause: unknown) => boolean;
}

export interface AcpSessionAcquisition {
	readonly sessionId: string;
	readonly resumed: boolean;
}

export const createAcpSession = async (
	options: CreateAcpSessionOptions,
): Promise<AcpSessionAcquisition> => {
	if (options.resumeCursor !== undefined && options.resumeCursor !== null) {
		const cursor = options.resumeCursor;
		const load = async (mcpServers: ReadonlyArray<unknown>) => {
			const result = await options.request("session/load", {
				sessionId: cursor,
				cwd: options.cwd,
				mcpServers,
				...(options.providerEventCursor == null
					? {}
					: { _meta: { cursor: options.providerEventCursor } }),
			});
			return {
				sessionId: Option.match(decodeSessionResult(result), {
					onNone: () => cursor,
					onSome: ({ sessionId }) => sessionId,
				}),
				resumed: true,
			} as const;
		};
		try {
			return await load(options.httpServers);
		} catch (cause) {
			if (
				options.httpServers.length > 0 &&
				options.fallbackServers !== undefined
			) {
				try {
					return await load(await options.fallbackServers());
				} catch {
					// The cursor itself is unavailable; create a replacement below.
				}
			}
			if (options.shouldReplaceMissingSession?.(cause) !== true) throw cause;
			console.warn(
				`[mcp-gateway] session ${options.sessionId} could not load cursor; creating a replacement: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		}
	}

	let result: unknown;
	try {
		result = await options.request("session/new", {
			cwd: options.cwd,
			mcpServers: options.httpServers,
		});
		console.info(
			`[mcp-gateway] session ${options.sessionId} connected via http`,
		);
	} catch (cause) {
		if (options.fallbackServers === undefined) throw cause;
		console.warn(
			`[mcp-gateway] session ${options.sessionId} http setup failed; using stdio-fallback: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
		result = await options.request("session/new", {
			cwd: options.cwd,
			mcpServers: await options.fallbackServers(),
		});
		console.info(
			`[mcp-gateway] session ${options.sessionId} connected via stdio-fallback`,
		);
	}
	const sessionId = Option.getOrThrowWith(
		decodeSessionResult(result),
		() =>
			new Error(
				`${options.providerLabel} ACP session/new returned no sessionId.`,
			),
	).sessionId;
	return { sessionId, resumed: false };
};
