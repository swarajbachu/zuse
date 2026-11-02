import { realpath } from "node:fs/promises";
import { toNamespacedPath } from "node:path";
import { spawnMspConnection } from "@muse-code/sdk";
import { Effect, Schema } from "effect";

export const museEnvironment = (extra?: Readonly<Record<string, string>>) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...extra,
		MUSE_NO_AUTO_UPDATE: "1",
	};
	// Native login is the default; only an explicit session override selects a key.
	if (!extra?.META_API_KEY) delete env.META_API_KEY;
	return env;
};

/** Own the process before awaiting the handshake, including timeout and cancellation. */
export const museLaunch = (
	binary: string,
	platform = process.platform,
	env = process.env,
) => {
	if (platform !== "win32" || !/\.(cmd|bat)$/i.test(binary))
		return { command: binary, args: [] as string[] };
	const comspec =
		Object.entries(env).find(([key]) => key.toLowerCase() === "comspec")?.[1] ??
		"cmd.exe";
	return {
		command: comspec,
		args: [
			"/d",
			"/c",
			...(/\s/.test(binary)
				? ["@", binary]
				: [binary.replace(/[()&<>@^|]/g, "^$&")]),
		],
	};
};

export const openMuseHost = async (
	binary: string,
	cwd: string,
	options: {
		readOnly?: boolean;
		readOnlyTools?: boolean;
		env?: Readonly<Record<string, string>>;
		signal?: AbortSignal;
	} = {},
) => {
	options.signal?.throwIfAborted();
	const launch = museLaunch(binary);
	const host = spawnMspConnection({
		command: launch.command,
		args: [
			...launch.args,
			...(options.readOnly
				? ["serve", "--disable-shell", "--disable-write", "--no-session-log"]
				: [
						"serve",
						"--trust-workspace",
						...(options.readOnlyTools
							? ["--disable-shell", "--disable-write"]
							: []),
					]),
		],
		cwd,
		env: museEnvironment(options.env),
		shutdownTimeoutMs: 2000,
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort = () => {};
	try {
		const initialized = await Promise.race([
			host.initialize({
				clientInfo: { name: "zuse", title: "Zuse", version: "1" },
				capabilities: {
					requestedCapabilities: options.readOnly ? [] : ["sessionMcp"],
				},
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Muse initialization timed out.")),
					15_000,
				);
				abort = () => reject(new Error("Muse initialization cancelled."));
				options.signal?.addEventListener("abort", abort, { once: true });
				if (options.signal?.aborted) abort();
			}),
		]);
		if (initialized.initializeResult.schema?.version !== 1)
			throw new Error("Unsupported Muse protocol version.");
		return initialized;
	} catch (error) {
		await host.close();
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
};

export const museWorkspaceRoot = async (cwd: string) =>
	toNamespacedPath(await realpath(cwd));

const Catalog = Schema.Struct({
	providerId: Schema.Literal("meta"),
	models: Schema.Array(
		Schema.Struct({
			modelId: Schema.NonEmptyString,
			displayLabel: Schema.String,
			providerId: Schema.String,
			isDefault: Schema.Boolean,
			variants: Schema.optional(
				Schema.Union([Schema.Array(Schema.String), Schema.Literal("unknown")]),
			),
		}),
	),
});

export const loadMuseInventory = (binary: string, cwd: string) =>
	Effect.acquireUseRelease(
		Effect.tryPromise((signal) =>
			openMuseHost(binary, cwd, { readOnly: true, signal }),
		),
		(host) =>
			Effect.tryPromise(async () => {
				const catalog = Schema.decodeUnknownSync(Catalog)(
					await host.connection.request("model/list", {}),
				);
				const seen = new Set<string>();
				return catalog.models
					.filter((model) => {
						if (model.providerId !== "meta" || seen.has(model.modelId))
							return false;
						seen.add(model.modelId);
						return true;
					})
					.map((model) => ({
						id: model.modelId,
						label: model.displayLabel.trim() || model.modelId,
						isDefault: model.isDefault,
						liveMeta: {
							reasoningEfforts:
								model.variants !== undefined && model.variants !== "unknown"
									? model.variants
									: ["low", "medium", "high", "xhigh", "max"],
						},
					}));
			}),
		(host) =>
			Effect.promise(async () => {
				await host.close();
			}),
	).pipe(
		Effect.mapError((error) =>
			error.cause instanceof Error
				? error.cause
				: new Error(String(error.cause)),
		),
	);
