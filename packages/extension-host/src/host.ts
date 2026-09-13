import { randomUUID } from "node:crypto";
import {
	cp,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type ExtensionCapability,
	type ExtensionCatalog,
	ExtensionError,
	type ExtensionListItem,
	type ExtensionLogEntry,
	type ExtensionManifest,
	type ExtensionSource,
	type MarketplaceExtension,
} from "@zuse/contracts";
import { compileExtension } from "./compiler.ts";
import {
	assertApiCompatible,
	compileEntries,
	RESERVED_PROVIDER_IDS,
	readExtensionManifest,
} from "./manifest.ts";
import {
	fetchMarketplaceCatalog,
	type MarketplaceCatalog,
	marketplaceItems,
} from "./marketplace.ts";
import { type RunningExtension, startExtensionProcess } from "./runtime.ts";
import { type PreparedSource, prepareSource } from "./source-manager.ts";
import type {
	CompiledExtension,
	ExtensionHostCommand,
	ExtensionHostCommandResult,
	ExtensionHostDependencies,
	ExtensionHostInterface,
} from "./types.ts";

interface StoredExtension {
	readonly source: ExtensionSource;
	readonly manifest: ExtensionManifest;
	readonly enabled: boolean;
	readonly grantedCapabilities: ReadonlyArray<ExtensionCapability>;
	readonly activeDirectory: string;
	readonly stateDirectory?: string;
	readonly activeCommit: string | null;
	readonly lastError: string | null;
}

interface StoredConfig {
	readonly schemaVersion: 1;
	readonly globallyEnabled: boolean;
	readonly knownProviders?: ReadonlyArray<
		import("@zuse/contracts").ExtensionProviderDescriptor
	>;
	readonly extensions: Readonly<Record<string, StoredExtension>>;
}

const emptyConfig = (): StoredConfig => ({
	schemaVersion: 1,
	globallyEnabled: false,
	extensions: {},
});

const describe = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const extensionError = (
	code: ConstructorParameters<typeof ExtensionError>[0]["code"],
	extensionId: string | null,
	cause: unknown,
): ExtensionError =>
	new ExtensionError({ code, extensionId, reason: describe(cause) });

const capabilitiesApproved = (
	manifest: ExtensionManifest,
	granted: ReadonlyArray<ExtensionCapability>,
): boolean => {
	const allowed = new Set(granted);
	return manifest.capabilities.every((capability) => allowed.has(capability));
};

const parseConfig = (value: unknown): StoredConfig => {
	if (value === null || typeof value !== "object") return emptyConfig();
	const input = value as Partial<StoredConfig>;
	if (input.schemaVersion !== 1 || typeof input.globallyEnabled !== "boolean") {
		return emptyConfig();
	}
	return {
		schemaVersion: 1,
		globallyEnabled: input.globallyEnabled,
		knownProviders: input.knownProviders ?? [],
		extensions:
			input.extensions && typeof input.extensions === "object"
				? input.extensions
				: {},
	};
};

export class ExtensionHost implements ExtensionHostInterface {
	private readonly configPath: string;
	private readonly storageDirectory: string;
	private readonly fetch: typeof globalThis.fetch;
	private readonly now: () => Date;
	private config = emptyConfig();
	private readonly running = new Map<string, RunningExtension>();
	private readonly listeners = new Set<(catalog: ExtensionCatalog) => void>();
	private readonly retainedLogs = new Map<string, ExtensionLogEntry[]>();
	private readonly providerEventListeners = new Set<
		(sessionId: string, event: unknown) => void
	>();
	private readonly sessionProviders = new Map<string, string>();
	private readonly restartAttempts = new Map<string, number>();
	private readonly restartTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private marketplaceCatalog: MarketplaceCatalog | null = null;
	private lifecycle = Promise.resolve();
	private stopped = false;
	private readonly busy = new Set<string>();
	private readonly healthyTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private persistence = Promise.resolve();

	constructor(private readonly dependencies: ExtensionHostDependencies) {
		const root = resolve(dependencies.rootDirectory);
		this.configPath = join(root, "extensions.json");
		this.storageDirectory = join(root, "storage");
		this.fetch = dependencies.fetch ?? globalThis.fetch;
		this.now = dependencies.now ?? (() => new Date());
	}

	async start(options: { background?: boolean } = {}): Promise<void> {
		await mkdir(this.dependencies.rootDirectory, {
			recursive: true,
			mode: 0o700,
		});
		try {
			this.config = parseConfig(
				JSON.parse(await readFile(this.configPath, "utf8")),
			);
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn("[extensions] could not read extension config", cause);
			}
		}
		await this.recoverArtifacts();
		if (!this.config.globallyEnabled) return;
		const resume = async () => {
			const ids = Object.entries(this.config.extensions)
				.filter(([, extension]) => extension.enabled)
				.map(([id]) => id);
			for (let index = 0; index < ids.length; index += 4) {
				await Promise.all(
					ids.slice(index, index + 4).map((id) =>
						this.startConfigured(id).catch((cause) => {
							void this.recordError(id, describe(cause));
						}),
					),
				);
			}
			this.publish();
		};
		if (options.background) {
			void this.enqueue(resume);
			return;
		}
		await this.enqueue(resume);
		this.publish();
	}

	snapshot(): ExtensionCatalog {
		return {
			globallyEnabled: this.config.globallyEnabled,
			knownProviders: this.config.knownProviders ?? [],
			items: Object.entries(this.config.extensions)
				.map(([id, extension]) => this.toListItem(id, extension))
				.sort((left, right) =>
					left.manifest.name.localeCompare(right.manifest.name),
				),
		};
	}

	subscribe(listener: (catalog: ExtensionCatalog) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async inspect(source: ExtensionSource): Promise<ExtensionManifest> {
		const prepared = await this.prepare(source);
		try {
			const manifest =
				prepared.manifest ?? (await readExtensionManifest(prepared.directory));
			assertApiCompatible(manifest.zuseApi);
			return manifest;
		} catch (cause) {
			throw extensionError("invalid-manifest", null, cause);
		} finally {
			if (prepared.temporaryRoot !== null) {
				await rm(prepared.temporaryRoot, { recursive: true, force: true });
			}
		}
	}

	execute(command: ExtensionHostCommand): Promise<ExtensionHostCommandResult> {
		return this.enqueue(async () => {
			switch (command._tag) {
				case "set-global-enabled":
					return this.setGlobalEnabled(command.enabled);
				case "install":
					return {
						_tag: "item",
						item: await this.install(
							command.source,
							command.grantedCapabilities,
						),
					};
				case "enable":
					return { _tag: "item", item: await this.enable(command.id) };
				case "disable":
					return { _tag: "item", item: await this.disable(command.id) };
				case "reload":
					return { _tag: "item", item: await this.reload(command.id) };
				case "update":
					return {
						_tag: "item",
						item: await this.update(command.id, command.grantedCapabilities),
					};
				case "remove":
					await this.remove(command.id, command.deleteData);
					return { _tag: "void" };
			}
		});
	}

	cancel(id: string, requestId: string): void {
		this.running.get(id)?.cancel(requestId);
	}
	async invoke(
		id: string,
		method: string,
		input: unknown,
		workspace?: import("@zuse/extension-sdk").ExtensionWorkspaceContext,
		requestId?: string,
	): Promise<unknown> {
		if (this.busy.has(id))
			throw extensionError(
				"busy",
				id,
				"Extension is being replaced. Retry shortly.",
			);
		const runtime = this.running.get(id);
		if (!runtime) {
			throw extensionError(
				"not-running",
				id,
				`Extension is not running: ${id}`,
			);
		}
		try {
			return await runtime.invoke(method, input, workspace, requestId);
		} catch (cause) {
			throw extensionError("rpc-failed", id, cause);
		}
	}

	providerDescriptors() {
		return [...this.running.values()]
			.flatMap((runtime) => runtime.providers)
			.sort(
				(left, right) =>
					left.order - right.order ||
					left.displayName.localeCompare(right.displayName),
			);
	}

	async invokeProvider(
		providerId: string,
		operation: string,
		input: unknown,
	): Promise<unknown> {
		const owner = [...this.running.values()].find((runtime) =>
			runtime.providers.some((provider) => provider.id === providerId),
		);
		if (!owner) {
			throw extensionError(
				"not-running",
				null,
				`Extension provider is unavailable: ${providerId}`,
			);
		}
		const sessionId =
			input &&
			typeof input === "object" &&
			typeof Reflect.get(input, "sessionId") === "string"
				? (Reflect.get(input, "sessionId") as string)
				: input &&
						typeof input === "object" &&
						Reflect.get(input, "input") &&
						typeof Reflect.get(
							Reflect.get(input, "input") as object,
							"sessionId",
						) === "string"
					? (Reflect.get(
							Reflect.get(input, "input") as object,
							"sessionId",
						) as string)
					: null;
		if (operation === "start" && sessionId !== null) {
			this.sessionProviders.set(sessionId, providerId);
		}
		try {
			if (this.busy.has(owner.id))
				throw extensionError("busy", owner.id, "Extension is being replaced.");
			return await owner.invoke(`provider:${providerId}:${operation}`, input);
		} catch (cause) {
			if (operation === "start" && sessionId !== null)
				this.sessionProviders.delete(sessionId);
			throw cause;
		} finally {
			if (operation === "close" && sessionId !== null)
				this.sessionProviders.delete(sessionId);
		}
	}

	subscribeProviderEvents(
		listener: (sessionId: string, event: unknown) => void,
	): () => void {
		this.providerEventListeners.add(listener);
		return () => this.providerEventListeners.delete(listener);
	}

	logs(id: string): ReadonlyArray<ExtensionLogEntry> {
		if (!this.config.extensions[id]) {
			throw extensionError(
				"not-found",
				id,
				`Extension is not installed: ${id}`,
			);
		}
		return [
			...(this.retainedLogs.get(id) ?? []),
			...(this.running.get(id)?.logs() ?? []),
		].slice(-500);
	}

	async marketplace(
		refresh = false,
	): Promise<ReadonlyArray<MarketplaceExtension>> {
		if (!this.dependencies.marketplace) return [];
		if (refresh || this.marketplaceCatalog === null) {
			try {
				this.marketplaceCatalog = await fetchMarketplaceCatalog({
					...this.dependencies.marketplace,
					fetch: this.fetch,
				});
			} catch (cause) {
				throw extensionError("signature-failed", null, cause);
			}
		}
		return marketplaceItems(
			this.marketplaceCatalog,
			new Map(
				Object.entries(this.config.extensions).map(([id, extension]) => [
					id,
					{
						version: extension.manifest.version,
						commit: extension.activeCommit,
					},
				]),
			),
		);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const timer of this.healthyTimers.values()) clearTimeout(timer);
		this.healthyTimers.clear();
		for (const timer of this.restartTimers.values()) clearTimeout(timer);
		this.restartTimers.clear();
		await this.enqueue(async () => {
			const running = [...this.running.entries()];
			this.running.clear();
			await Promise.all(
				running.map(async ([id, runtime]) => {
					this.retainLogs(id, runtime.logs());
					await runtime.stop();
				}),
			);
		});
	}

	private enqueue<A>(operation: () => Promise<A>): Promise<A> {
		const result = this.lifecycle.then(operation, operation);
		this.lifecycle = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async setGlobalEnabled(
		enabled: boolean,
	): Promise<ExtensionHostCommandResult> {
		if (enabled === this.config.globallyEnabled) {
			return { _tag: "catalog", catalog: this.snapshot() };
		}
		this.config = { ...this.config, globallyEnabled: enabled };
		if (!enabled) {
			for (const timer of this.restartTimers.values()) clearTimeout(timer);
			this.restartTimers.clear();
			for (const id of this.running.keys()) {
				await this.closeOwnedSessions(id);
				this.endSessions(id, "Extensions were disabled.");
			}
		}
		await this.persist();
		if (!enabled) {
			const runtimes = [...this.running.entries()];
			this.running.clear();
			await Promise.all(
				runtimes.map(async ([id, runtime]) => {
					this.retainLogs(id, runtime.logs());
					await runtime.stop();
				}),
			);
		} else {
			for (const [id, extension] of Object.entries(this.config.extensions)) {
				if (extension.enabled) {
					await this.startConfigured(id).catch((cause) =>
						this.recordError(id, describe(cause)),
					);
				}
			}
		}
		this.publish();
		return { _tag: "catalog", catalog: this.snapshot() };
	}

	private async install(
		source: ExtensionSource,
		grantedCapabilities: ReadonlyArray<ExtensionCapability>,
	): Promise<ExtensionListItem> {
		const prepared = await this.prepare(source);
		const previousConfig = this.config;
		let candidate: RunningExtension | null = null;
		let activeDirectory: string | null = null;
		let committed = false;
		try {
			const manifest =
				prepared.manifest ?? (await readExtensionManifest(prepared.directory));
			assertApiCompatible(manifest.zuseApi);
			if (this.config.extensions[manifest.id]) {
				throw extensionError(
					"already-installed",
					manifest.id,
					"Extension ID is already installed.",
				);
			}
			this.assertCapabilities(manifest, grantedCapabilities);
			const compiled =
				prepared.compiled ??
				(await compileExtension(compileEntries(prepared.directory, manifest)));
			activeDirectory = await this.publishCompiled(manifest.id, compiled);
			const stateDirectory = join(activeDirectory, "state");
			await cp(join(this.storageDirectory, manifest.id), stateDirectory, {
				recursive: true,
			}).catch((cause: NodeJS.ErrnoException) => {
				if (cause.code !== "ENOENT") throw cause;
			});
			candidate = await this.startCandidate(
				manifest.id,
				compiled,
				grantedCapabilities,
				stateDirectory,
			);
			this.assertProviderIds(manifest, candidate);
			this.rememberProviders(candidate.providers);
			if (prepared.temporaryRoot !== null) {
				await rm(prepared.temporaryRoot, { recursive: true, force: true });
			}
			const stored: StoredExtension = {
				source,
				manifest,
				enabled: true,
				grantedCapabilities: [...new Set(grantedCapabilities)],
				activeDirectory,
				stateDirectory,
				activeCommit: prepared.commit,
				lastError: null,
			};
			this.config = {
				...this.config,
				extensions: { ...this.config.extensions, [manifest.id]: stored },
			};
			await this.persist();
			committed = true;
			if (this.config.globallyEnabled) {
				this.running.set(manifest.id, candidate);
				candidate.activate();
				this.markHealthy(manifest.id, candidate);
			} else await candidate.stop();
			candidate = null;
			this.publish();
			return this.toListItem(manifest.id, stored);
		} catch (cause) {
			await candidate?.stop().catch(() => {});
			if (!committed) {
				this.config = previousConfig;
				if (activeDirectory)
					await rm(activeDirectory, { recursive: true, force: true });
			}
			if (prepared.temporaryRoot !== null) {
				await rm(prepared.temporaryRoot, { recursive: true, force: true });
			}
			if (cause instanceof ExtensionError) throw cause;
			throw extensionError("startup-failed", null, cause);
		}
	}

	private async enable(id: string): Promise<ExtensionListItem> {
		const stored = this.requireStored(id);
		if (!capabilitiesApproved(stored.manifest, stored.grantedCapabilities)) {
			throw extensionError(
				"capability-approval-required",
				id,
				"Extension capabilities require approval.",
			);
		}
		this.restartAttempts.delete(id);
		const next = { ...stored, enabled: true, lastError: null };
		this.replaceStored(id, next);
		await this.persist();
		if (this.config.globallyEnabled && !this.running.has(id))
			await this.startConfigured(id);
		this.publish();
		return this.toListItem(id, next);
	}

	private async disable(id: string): Promise<ExtensionListItem> {
		await this.closeOwnedSessions(id);
		this.endSessions(id, "Extension was disabled.");
		const stored = this.requireStored(id);
		const runtime = this.running.get(id);
		this.running.delete(id);
		const restartTimer = this.restartTimers.get(id);
		if (restartTimer) clearTimeout(restartTimer);
		this.restartTimers.delete(id);
		this.restartAttempts.delete(id);
		const next = { ...stored, enabled: false, lastError: null };
		this.replaceStored(id, next);
		await this.persist();
		if (runtime) {
			this.retainLogs(id, runtime.logs());
			await runtime.stop();
		}
		this.publish();
		return this.toListItem(id, next);
	}

	private async reload(id: string): Promise<ExtensionListItem> {
		const stored = this.requireStored(id);
		return this.activateReplacement(
			id,
			stored.source,
			stored.grantedCapabilities,
		);
	}

	private async update(
		id: string,
		grantedCapabilities: ReadonlyArray<ExtensionCapability>,
	): Promise<ExtensionListItem> {
		const stored = this.requireStored(id);
		if (stored.source._tag === "directory") {
			throw extensionError(
				"invalid-source",
				id,
				"Directory extensions use reload, not update.",
			);
		}
		if (stored.source._tag === "marketplace") await this.marketplace(true);
		return this.activateReplacement(id, stored.source, grantedCapabilities);
	}

	private async activateReplacement(
		id: string,
		source: ExtensionSource,
		grantedCapabilities: ReadonlyArray<ExtensionCapability>,
	): Promise<ExtensionListItem> {
		const current = this.requireStored(id);
		const previousConfig = this.config;
		const owners = new Set<string>(
			this.running.get(id)?.providers.map((provider) => provider.id),
		);
		if (
			[...this.sessionProviders.values()].some((provider) =>
				owners.has(provider),
			)
		) {
			throw extensionError(
				"busy",
				id,
				"Close this extension's provider sessions before updating or reloading.",
			);
		}
		this.busy.add(id);
		let candidate: RunningExtension | null = null;
		let prepared: PreparedSource | null = null;
		let activeDirectory: string | null = null;
		let quiesced = false;
		let committed = false;
		try {
			prepared = await this.prepare(source);
			const manifest =
				prepared.manifest ?? (await readExtensionManifest(prepared.directory));
			if (manifest.id !== id)
				throw new Error(`Manifest ID changed from ${id} to ${manifest.id}.`);
			assertApiCompatible(manifest.zuseApi);
			this.assertCapabilities(manifest, grantedCapabilities);
			const compiled =
				prepared.compiled ??
				(await compileExtension(compileEntries(prepared.directory, manifest)));
			activeDirectory = await this.publishCompiled(id, compiled);
			const previous = this.running.get(id);
			this.running.delete(id);
			if (previous) {
				this.retainLogs(id, previous.logs());
				await previous.stop();
			}
			quiesced = true;
			const stateDirectory = join(activeDirectory, "state");
			const previousState =
				current.stateDirectory ?? join(this.storageDirectory, id);
			if (await stat(previousState).catch(() => null))
				await cp(previousState, stateDirectory, { recursive: true });
			candidate = await this.startCandidate(
				id,
				compiled,
				grantedCapabilities,
				stateDirectory,
			);
			this.assertProviderIds(manifest, candidate);
			this.rememberProviders(candidate.providers);
			const next: StoredExtension = {
				...current,
				manifest,
				grantedCapabilities: [...new Set(grantedCapabilities)],
				activeDirectory,
				stateDirectory,
				activeCommit: prepared.commit,
				lastError: null,
			};
			this.replaceStored(id, next);
			try {
				await this.persist();
			} catch (cause) {
				this.replaceStored(id, current);
				throw cause;
			}
			committed = true;
			if (this.config.globallyEnabled && next.enabled) {
				this.running.set(id, candidate);
				candidate.activate();
				this.markHealthy(id, candidate);
			} else await candidate.stop();
			candidate = null;
			this.restartAttempts.delete(id);
			this.publish();
			return this.toListItem(id, next);
		} catch (cause) {
			await candidate?.stop().catch(() => {});
			if (!committed) this.config = previousConfig;
			if (!committed && activeDirectory)
				await rm(activeDirectory, { recursive: true, force: true });
			if (
				quiesced &&
				!committed &&
				this.config.globallyEnabled &&
				current.enabled
			)
				await this.startConfigured(id).catch((error) =>
					this.recordError(id, describe(error)),
				);
			throw extensionError("startup-failed", id, cause);
		} finally {
			this.busy.delete(id);
			if (prepared?.temporaryRoot)
				await rm(prepared.temporaryRoot, { recursive: true, force: true });
		}
	}

	private async remove(id: string, deleteData: boolean): Promise<void> {
		await this.closeOwnedSessions(id);
		this.endSessions(id, "Extension was removed.");
		const stored = this.requireStored(id);
		const runtime = this.running.get(id);
		this.running.delete(id);
		const restartTimer = this.restartTimers.get(id);
		if (restartTimer) clearTimeout(restartTimer);
		this.restartTimers.delete(id);
		this.restartAttempts.delete(id);
		const extensions = { ...this.config.extensions };
		delete extensions[id];
		this.config = { ...this.config, extensions };
		await this.persist();
		await runtime?.stop();
		this.retainedLogs.delete(id);
		if (deleteData) await this.dependencies.secretStore.delete(id, "*");
		else if (
			stored.stateDirectory &&
			(await stat(stored.stateDirectory).catch(() => null))
		)
			await cp(stored.stateDirectory, join(this.storageDirectory, id), {
				recursive: true,
			});
		if (deleteData) {
			await rm(join(this.storageDirectory, id), {
				recursive: true,
				force: true,
			});
		}
		if (stored.source._tag !== "directory") {
			await rm(join(this.dependencies.rootDirectory, "sources", id), {
				recursive: true,
				force: true,
			});
		}
		await rm(join(this.dependencies.rootDirectory, "artifacts", id), {
			recursive: true,
			force: true,
		});
		this.publish();
	}

	private async prepare(source: ExtensionSource): Promise<PreparedSource> {
		if (source._tag === "marketplace" && this.marketplaceCatalog === null) {
			await this.marketplace(true);
		}
		try {
			return await prepareSource({
				source,
				rootDirectory: this.dependencies.rootDirectory,
				marketplace: this.marketplaceCatalog,
				fetch: this.fetch,
			});
		} catch (cause) {
			throw extensionError("invalid-source", null, cause);
		}
	}

	private async startConfigured(id: string): Promise<void> {
		const stored = this.requireStored(id);
		if (
			!this.config.globallyEnabled ||
			!stored.enabled ||
			this.running.has(id) ||
			this.stopped
		)
			return;
		const compiled = await this.readCompiled(stored);
		const runtime = await this.startCandidate(
			id,
			compiled,
			stored.grantedCapabilities,
			stored.stateDirectory,
		);
		try {
			this.assertProviderIds(stored.manifest, runtime);
		} catch (cause) {
			await runtime.stop();
			throw cause;
		}
		this.rememberProviders(runtime.providers);
		this.running.set(id, runtime);
		runtime.activate();
		this.markHealthy(id, runtime);
		if (stored.lastError !== null) {
			this.replaceStored(id, { ...stored, lastError: null });
			await this.persist();
		}
	}

	private startCandidate(
		id: string,
		compiled: Awaited<ReturnType<typeof compileExtension>>,
		capabilities: ReadonlyArray<ExtensionCapability>,
		stateDirectory = join(this.storageDirectory, id),
	): Promise<RunningExtension> {
		let instance: RunningExtension | null = null;
		return startExtensionProcess({
			id,
			compiled,
			capabilities,
			storagePath: join(stateDirectory, "state.json"),
			secretStore: this.dependencies.secretStore,
			now: this.now,
			onExit: (error) => {
				if (instance === null || this.running.get(id) !== instance) return;
				this.retainLogs(id, instance.logs());
				this.endSessions(id, error);
				this.running.delete(id);
				void this.enqueue(async () => {
					await this.recordError(id, error);
					this.scheduleRestart(id);
				});
			},
		}).then((runtime) => {
			instance = runtime;
			runtime.onProviderEvent((sessionId, event) => {
				if (this.running.get(id) !== runtime) return;
				for (const listener of this.providerEventListeners)
					listener(sessionId, event);
			});
			return runtime;
		});
	}

	private async publishCompiled(
		id: string,
		compiled: CompiledExtension,
	): Promise<string> {
		const parent = join(this.dependencies.rootDirectory, "artifacts", id);
		await mkdir(parent, { recursive: true, mode: 0o700 });
		const revision = `${Date.now().toString(36)}-${randomUUID()}`;
		const temporary = join(parent, `.${revision}.tmp`);
		const destination = join(parent, revision);
		await mkdir(temporary, { mode: 0o700 });
		try {
			await writeFile(
				join(temporary, "compiled.json"),
				JSON.stringify(compiled),
				{ mode: 0o600 },
			);
			await rename(temporary, destination);
			return destination;
		} finally {
			await rm(temporary, { recursive: true, force: true }).catch(() => {});
		}
	}

	private async readCompiled(
		stored: StoredExtension,
	): Promise<CompiledExtension> {
		try {
			const parsed = JSON.parse(
				await readFile(join(stored.activeDirectory, "compiled.json"), "utf8"),
			) as Partial<CompiledExtension>;
			if (
				typeof parsed.clientBundle !== "string" ||
				typeof parsed.clientCss !== "string" ||
				typeof parsed.serverBundle !== "string"
			) {
				throw new Error("Compiled extension artifact is invalid.");
			}
			return parsed as CompiledExtension;
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
			// One-time compatibility path for configurations created before bundles
			// were published as immutable artifacts.
			return compileExtension(
				compileEntries(stored.activeDirectory, stored.manifest),
			);
		}
	}

	private scheduleRestart(id: string): void {
		const stored = this.config.extensions[id];
		if (this.stopped || !this.config.globallyEnabled || !stored?.enabled)
			return;
		const attempt = (this.restartAttempts.get(id) ?? 0) + 1;
		if (attempt > 3) return;
		this.restartAttempts.set(id, attempt);
		const delay = [250, 1_000, 4_000][attempt - 1] ?? 4_000;
		const timer = setTimeout(() => {
			this.restartTimers.delete(id);
			void this.enqueue(() => this.startConfigured(id)).catch((cause) => {
				void this.recordError(id, describe(cause));
				this.scheduleRestart(id);
			});
		}, delay);
		this.restartTimers.set(id, timer);
	}

	private assertCapabilities(
		manifest: ExtensionManifest,
		granted: ReadonlyArray<ExtensionCapability>,
	): void {
		if (!capabilitiesApproved(manifest, granted)) {
			throw extensionError(
				"capability-approval-required",
				manifest.id,
				"Every requested extension capability must be explicitly approved.",
			);
		}
	}

	private assertProviderIds(
		manifest: ExtensionManifest,
		candidate: RunningExtension,
	): void {
		const id = manifest.id;
		const occupied = new Set<string>();
		for (const [extensionId, runtime] of this.running) {
			if (extensionId === id) continue;
			for (const provider of runtime.providers) occupied.add(provider.id);
		}
		for (const provider of candidate.providers) {
			if (RESERVED_PROVIDER_IDS.has(provider.id)) {
				throw new Error(
					`Extension provider may not replace built-in provider ${provider.id}.`,
				);
			}
			if (occupied.has(provider.id)) {
				throw new Error(
					`Extension provider ID is already registered: ${provider.id}.`,
				);
			}
			if (!provider.id.startsWith(`${id}.`)) {
				throw new Error(
					`Extension provider IDs must be namespaced with ${id}.`,
				);
			}
			if (
				!manifest.capabilities.includes("providers") ||
				!manifest.contributions.includes("provider")
			) {
				throw new Error(
					"Provider registrations require the providers capability and provider contribution declaration.",
				);
			}
			if (
				provider.authentication._tag === "api-key" &&
				!manifest.capabilities.includes("credentials")
			) {
				throw new Error(
					"API-key providers require the credentials capability.",
				);
			}
		}
	}

	private requireStored(id: string): StoredExtension {
		const stored = this.config.extensions[id];
		if (!stored)
			throw extensionError(
				"not-found",
				id,
				`Extension is not installed: ${id}`,
			);
		return stored;
	}

	private replaceStored(id: string, stored: StoredExtension): void {
		this.config = {
			...this.config,
			extensions: { ...this.config.extensions, [id]: stored },
		};
	}

	private async recordError(id: string, error: string): Promise<void> {
		const stored = this.config.extensions[id];
		if (!stored) return;
		this.replaceStored(id, { ...stored, lastError: error });
		await this.persist().catch(() => {});
		this.publish();
	}

	private retainLogs(id: string, logs: ReadonlyArray<ExtensionLogEntry>): void {
		this.retainedLogs.set(
			id,
			[...(this.retainedLogs.get(id) ?? []), ...logs].slice(-500),
		);
	}

	private rememberProviders(
		providers: ReadonlyArray<
			import("@zuse/contracts").ExtensionProviderDescriptor
		>,
	): void {
		const known = new Map(
			(this.config.knownProviders ?? []).map((provider) => [
				provider.id,
				provider,
			]),
		);
		for (const provider of providers) known.set(provider.id, provider);
		this.config = { ...this.config, knownProviders: [...known.values()] };
	}
	private toListItem(id: string, stored: StoredExtension): ExtensionListItem {
		const runtime = this.running.get(id);
		const enabled = stored.enabled;
		const status =
			!enabled || !this.config.globallyEnabled
				? "disabled"
				: runtime
					? "running"
					: stored.lastError
						? "failed"
						: "loading";
		return {
			id: id as ExtensionListItem["id"],
			manifest: stored.manifest,
			source: stored.source,
			status,
			enabled,
			grantedCapabilities: [...stored.grantedCapabilities],
			activeCommit: stored.activeCommit,
			availableCommit: null,
			error: stored.lastError,
			providers: runtime?.providers ?? [],
			clientBundle: runtime?.clientBundle ?? null,
			clientCss: runtime?.clientCss ?? "",
		};
	}

	private persist(): Promise<void> {
		const config = this.config;
		const result = this.persistence.then(() => this.writeConfig(config));
		this.persistence = result.catch(() => {});
		return result;
	}
	private async writeConfig(config: StoredConfig): Promise<void> {
		await mkdir(this.dependencies.rootDirectory, {
			recursive: true,
			mode: 0o700,
		});
		const temporary = `${this.configPath}.tmp.${process.pid}`;
		try {
			await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
				mode: 0o600,
			});
			await rename(temporary, this.configPath);
		} finally {
			await rm(temporary, { force: true }).catch(() => {});
		}
	}

	private markHealthy(id: string, runtime: RunningExtension): void {
		clearTimeout(this.healthyTimers.get(id));
		const timer = setTimeout(() => {
			if (this.running.get(id) === runtime) this.restartAttempts.delete(id);
			this.healthyTimers.delete(id);
		}, 60_000);
		timer.unref();
		this.healthyTimers.set(id, timer);
	}

	private async closeOwnedSessions(id: string): Promise<void> {
		const runtime = this.running.get(id);
		if (!runtime) return;
		const providers = new Set(
			runtime.providers.map((provider) => String(provider.id)),
		);
		const pending = [...this.sessionProviders].filter(([, provider]) =>
			providers.has(provider),
		);
		if (!pending.length) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled(
					pending.map(([sessionId, providerId]) =>
						runtime.invoke(`provider:${providerId}:close`, { sessionId }),
					),
				),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 5000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	private endSessions(id: string, reason: string): void {
		const owned = new Set<string>(
			this.running.get(id)?.providers.map((provider) => provider.id),
		);
		for (const [sessionId, providerId] of this.sessionProviders) {
			if (!owned.has(providerId)) continue;
			this.sessionProviders.delete(sessionId);
			for (const listener of this.providerEventListeners) {
				listener(sessionId, { _tag: "Error", message: reason });
				listener(sessionId, { _tag: "Status", status: "error" });
			}
		}
	}

	private async recoverArtifacts(): Promise<void> {
		const root = join(this.dependencies.rootDirectory, "artifacts");
		for (const entry of await readdir(root, { withFileTypes: true }).catch(
			() => [],
		)) {
			if (!entry.isDirectory()) continue;
			const active = this.config.extensions[entry.name]?.activeDirectory;
			for (const revision of await readdir(join(root, entry.name), {
				withFileTypes: true,
			})) {
				const path = join(root, entry.name, revision.name);
				if (revision.isDirectory() && path !== active)
					await rm(path, { recursive: true, force: true });
			}
		}
	}

	private publish(): void {
		const catalog = this.snapshot();
		for (const listener of this.listeners) listener(catalog);
	}
}
