import { homedir } from "node:os";
import { Effect } from "effect";
import { PiRpcClient, piObject } from "./pi-rpc.ts";

/** Management reads never share a chat process or create a session transcript. */
export const loadPiInventory = (binary: string) =>
	Effect.acquireUseRelease(
		Effect.sync(
			() =>
				new PiRpcClient(
					binary,
					["--mode", "rpc", "--no-session"],
					homedir(),
					() => {},
				),
		),
		(rpc) =>
			Effect.tryPromise(async () => {
				const result = await rpc.request("get_available_models", {}, 10_000);
				if (!Array.isArray(result.models))
					throw new Error("Pi returned an invalid model inventory.");
				return result.models
					.map(piObject)
					.filter(
						(m) => typeof m.provider === "string" && typeof m.id === "string",
					)
					.map((m) => ({
						id: `${m.provider}/${m.id}`,
						label: typeof m.name === "string" ? m.name : String(m.id),
						liveMeta: {
							...(typeof m.contextWindow === "number"
								? { contextWindowTokens: m.contextWindow }
								: {}),
						},
					}));
			}).pipe(
				Effect.mapError((error) =>
					error.cause instanceof Error
						? error.cause
						: new Error(String(error.cause)),
				),
			),
		(rpc) => Effect.promise(() => rpc.close()),
	);
