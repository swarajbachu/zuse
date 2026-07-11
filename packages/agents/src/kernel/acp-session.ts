import { Option, Schema } from "effect";

const SessionResult = Schema.Struct({ sessionId: Schema.String });
const decodeSessionResult = Schema.decodeUnknownOption(SessionResult);

export interface CreateAcpSessionOptions {
	readonly request: (method: string, params: unknown) => Promise<unknown>;
	readonly cwd: string;
	readonly sessionId: string;
	readonly providerLabel: string;
	readonly httpServers: ReadonlyArray<unknown>;
	readonly fallbackServers: () => Promise<ReadonlyArray<unknown>>;
}

export const createAcpSession = async (
	options: CreateAcpSessionOptions,
): Promise<string> => {
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
	return Option.getOrThrowWith(
		decodeSessionResult(result),
		() =>
			new Error(
				`${options.providerLabel} ACP session/new returned no sessionId.`,
			),
	).sessionId;
};
