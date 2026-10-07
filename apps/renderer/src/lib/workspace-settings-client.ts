import "@zuse/i18n/english/common";
import { makeResourceKey } from "@zuse/client-runtime/resource-ref";
import {
	CloudWorkspaceOpError,
	EnvironmentId,
	RpcAccessDeniedError,
	WorkspaceSettings,
	WorkspaceSettingsValues,
} from "@zuse/contracts";
import { message } from "@zuse/i18n";
import { Effect, Schema } from "effect";
import { createAtomStore } from "../state/atom-store.ts";
import { getCloudControlClient } from "./cloud-control-client.ts";
import { organizationWorkspacesAvailable } from "./organization-workspaces.ts";
import {
	isHostedProduct,
	rendererPlatformCapabilities,
} from "./platform-capabilities.ts";
import {
	assertRendererAccountCurrent,
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "./renderer-account.ts";
import {
	assertRendererWorkspaceCurrent,
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "./renderer-workspace.ts";
import { getLocalEnvironmentId } from "./rpc-client.ts";
import { makeLocalStorageResourcePersistence } from "./storage-resource-persistence.ts";

type State = {
	readonly data: WorkspaceSettings | null;
	readonly origin: "none" | "cache" | "runtime";
	readonly loading: boolean;
	readonly error: string | null;
};

const personalPersistence = makeLocalStorageResourcePersistence({
	storage: () => (typeof window === "undefined" ? null : window.localStorage),
	prefix: "zuse.resource.workspace-settings",
	version: 1,
	decode: Schema.decodeUnknownSync(WorkspaceSettings),
});

/** Account API projection; runtime settings remain in their existing ClientBus cells. */
export const useWorkspaceSettingsState = createAtomStore<State>(() => ({
	data: null,
	origin: "none",
	loading: false,
	error: null,
}));
let pendingRead: Promise<WorkspaceSettings> | null = null;
let pendingWrite: Promise<unknown> = Promise.resolve();
let accessEpoch = 0;
// Last settings per account and workspace, so switching back renders at once
// and revalidates in the background. Display only: writes reload first.
const snapshots = new Map<string, WorkspaceSettings>();
const reset = () => {
	accessEpoch += 1;
	pendingRead = null;
	pendingWrite = Promise.resolve();
	const cache = settingsCache();
	const cached = cache === null ? undefined : snapshots.get(cache.namespace);
	useWorkspaceSettingsState.setState({
		data: cached ?? null,
		origin: cached === undefined ? "none" : "cache",
		loading: false,
		error: null,
	});
};
subscribeRendererAccount(() => snapshots.clear());
subscribeRendererAccount(reset);
subscribeRendererWorkspace(reset);

let consumers = 0;
let stopRefresh: (() => void) | null = null;

export const usesAccountWorkspaceSettings = () =>
	isHostedProduct() ||
	rendererWorkspaceSnapshot().scope.kind === "organization" ||
	(organizationWorkspacesAvailable() &&
		rendererPlatformCapabilities().desktop &&
		typeof rendererAccountSnapshot().subject === "string");

export const isDesktopPersonalWorkspace = () =>
	!isHostedProduct() &&
	rendererPlatformCapabilities().desktop &&
	rendererWorkspaceSnapshot().scope.kind === "personal";

/** One visible-window refresh loop, shared by all settings selectors. */
export const retainWorkspaceSettings = (): (() => void) => {
	consumers += 1;
	void loadWorkspaceSettings().catch(() => undefined);
	if (consumers === 1 && typeof window !== "undefined") {
		const refresh = () => {
			if (
				document.visibilityState === "hidden" ||
				!usesAccountWorkspaceSettings()
			)
				return;
			void loadWorkspaceSettings(true).catch(() => undefined);
		};
		const interval = window.setInterval(refresh, 15_000);
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		stopRefresh = () => {
			window.clearInterval(interval);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}
	return () => {
		consumers -= 1;
		if (consumers === 0) {
			stopRefresh?.();
			stopRefresh = null;
		}
	};
};

/** Desktop caches each account's Personal and organization settings separately. */
function settingsCache() {
	const account = rendererAccountSnapshot();
	if (
		!organizationWorkspacesAvailable() ||
		isHostedProduct() ||
		!rendererPlatformCapabilities().desktop ||
		typeof account.subject !== "string"
	)
		return null;
	return {
		key: makeResourceKey<WorkspaceSettings>("workspace-settings", {
			environmentId: EnvironmentId.make(getLocalEnvironmentId()),
		}),
		namespace: JSON.stringify([
			account.subject,
			rendererWorkspaceSnapshot().key,
		]),
	};
}

const requestContext = () => {
	const epoch = accessEpoch;
	const account = rendererAccountSnapshot();
	const workspace = rendererWorkspaceSnapshot();
	const personal =
		organizationWorkspacesAvailable() &&
		isDesktopPersonalWorkspace() &&
		typeof account.subject === "string";
	return {
		scope: workspace.scope,
		migratePersonal: personal,
		cache: settingsCache(),
		assertCurrent: () => {
			assertRendererAccountCurrent(account);
			assertRendererWorkspaceCurrent(workspace);
			if (epoch !== accessEpoch)
				throw new Error("Workspace settings access changed.");
		},
		isCurrent: () =>
			epoch === accessEpoch &&
			rendererAccountSnapshot() === account &&
			rendererWorkspaceSnapshot() === workspace,
	};
};

const accept = (
	data: WorkspaceSettings,
	origin: State["origin"] = "runtime",
) => {
	const previous = useWorkspaceSettingsState.getState().data;
	if (previous === null || data.revision >= previous.revision)
		useWorkspaceSettingsState.setState({ data, origin, error: null });
};

const persist = (context: ReturnType<typeof requestContext>) => {
	const data = useWorkspaceSettingsState.getState().data;
	if (context.cache !== null && data !== null && context.isCurrent())
		snapshots.set(context.cache.namespace, data);
	if (context.cache !== null && data !== null)
		void personalPersistence.saveResource(
			context.cache.key,
			{
				data,
				cursor: null,
				storedAt: Date.now(),
			},
			context.cache.namespace,
		);
};

export const loadWorkspaceSettings = (
	refresh = false,
): Promise<WorkspaceSettings> => {
	if (pendingRead !== null) return pendingRead;
	const current = useWorkspaceSettingsState.getState();
	const existing = current.data;
	// Cached settings are for display; callers asking for settings get live ones.
	if (!refresh && existing !== null && current.origin !== "cache")
		return Promise.resolve(existing);
	const context = requestContext();
	useWorkspaceSettingsState.setState({ loading: true, error: null });
	const request = (async () => {
		try {
			if (existing === null && context.cache !== null) {
				const cached = await personalPersistence.loadResource(
					context.cache.key,
					context.cache.namespace,
				);
				context.assertCurrent();
				if (cached !== null) {
					accept(cached.data, "cache");
					snapshots.set(context.cache.namespace, cached.data);
				}
			}
			const client = await getCloudControlClient(context.scope);
			context.assertCurrent();
			let data = await Effect.runPromise(client["cloud.settings.get"]());
			context.assertCurrent();
			if (context.migratePersonal && data.revision === 0) {
				const { readPersonalSettingsForMigration } = await import(
					"./settings-client-bus.ts"
				);
				context.assertCurrent();
				const values = Schema.decodeUnknownSync(WorkspaceSettingsValues)(
					await readPersonalSettingsForMigration(),
				);
				context.assertCurrent();
				try {
					data = await Effect.runPromise(
						client["cloud.settings.update"]({
							expectedRevision: 0,
							values,
						}),
					);
				} catch (error) {
					context.assertCurrent();
					if (
						!(error instanceof CloudWorkspaceOpError) ||
						error.code !== "conflict"
					)
						throw error;
					// Another device initialized this workspace. Adopt it; never overwrite it.
					data = await Effect.runPromise(client["cloud.settings.get"]());
				}
			}
			context.assertCurrent();
			accept(data);
			persist(context);
			return useWorkspaceSettingsState.getState().data ?? data;
		} catch (error) {
			if (context.isCurrent()) {
				if (
					(error instanceof CloudWorkspaceOpError &&
						error.code === "not-allowed") ||
					error instanceof RpcAccessDeniedError
				) {
					accessEpoch += 1;
					pendingRead = null;
					useWorkspaceSettingsState.setState({
						data: null,
						origin: "none",
						loading: false,
					});
					if (context.cache !== null) snapshots.delete(context.cache.namespace);
					if (context.cache !== null)
						void personalPersistence.removeResource(
							context.cache.key,
							context.cache.namespace,
						);
				}
				useWorkspaceSettingsState.setState({
					error: message("common:workspace_settings_load_failed"),
				});
				const cached = useWorkspaceSettingsState.getState().data;
				if (
					context.cache !== null &&
					cached !== null &&
					error instanceof CloudWorkspaceOpError &&
					error.code === "provider-unavailable"
				)
					return cached;
			}
			throw error;
		} finally {
			if (context.isCurrent()) {
				pendingRead = null;
				useWorkspaceSettingsState.setState({ loading: false });
			}
		}
	})();
	pendingRead = request;
	return request;
};

/** Serialize this client's edits; a remote revision conflict is surfaced, never blindly retried. */
export const updateWorkspaceSettings = (
	patch: (values: WorkspaceSettingsValues) => WorkspaceSettingsValues,
): Promise<void> => {
	const context = requestContext();
	const operation = pendingWrite.then(async () => {
		context.assertCurrent();
		const current = await loadWorkspaceSettings();
		context.assertCurrent();
		const client = await getCloudControlClient(context.scope);
		context.assertCurrent();
		const data = await Effect.runPromise(
			client["cloud.settings.update"]({
				expectedRevision: current.revision,
				values: { ...current.values, ...patch(current.values) },
			}),
		);
		context.assertCurrent();
		accept(data);
		persist(context);
	});
	pendingWrite = operation.catch(() => undefined);
	return operation.catch((error) => {
		if (context.isCurrent())
			useWorkspaceSettingsState.setState({
				error: message("common:workspace_settings_save_failed"),
			});
		throw error;
	});
};
