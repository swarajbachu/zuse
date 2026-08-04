import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import {
	makeResourceKey,
	type ResourceKey,
} from "@zuse/client-runtime/resource-ref";
import {
	type AppearanceMode,
	type AutonomyLevel,
	type BranchNamingStyle,
	CommandId,
	type CompletionSoundPreset,
	defaultModelEnabledByProvider,
	defaultModelFor,
	EnvironmentId,
	type GitMergeMethod,
	type ModelEnabledByProvider,
	type OpencodeCustomProvider,
	type ProviderId,
	type RuntimeMode,
	resolveModelSlug,
	runtimeModeForProvider,
	type SettingsFile,
	type SettingsPatch,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";
import { readStorageWithLegacy, removeStorageKeys } from "./storage-keys.ts";

/** Canonical environment-qualified projection of `settings.json`. */
export interface SettingsSlice {
	readonly defaultProviderId: ProviderId;
	readonly defaultModelByProvider: Record<ProviderId, string>;
	readonly defaultRuntimeMode: RuntimeMode;
	readonly defaultAutoCreateWorktree: boolean;
	readonly defaultAutonomyLevel: AutonomyLevel;
	readonly completionSoundEnabled: boolean;
	readonly completionSoundPreset: CompletionSoundPreset;
	readonly appearanceMode: AppearanceMode;
	readonly onboardingCompleted: boolean;
	readonly providerEnabled: Record<ProviderId, boolean>;
	readonly modelEnabledByProvider: ModelEnabledByProvider;
	readonly customModelIdsByProvider: Record<ProviderId, ReadonlyArray<string>>;
	readonly opencodeProviderVisible: Record<string, boolean>;
	readonly opencodeModelVisibleByProvider: Record<
		string,
		Record<string, boolean>
	>;
	readonly opencodeCustomProviders: ReadonlyArray<OpencodeCustomProvider>;
	readonly branchNamingStyle: BranchNamingStyle;
	readonly branchNamingPrefix: string;
	readonly mergePrefs: { method: GitMergeMethod; deleteBranch: boolean };
	readonly notchTrayEnabled: boolean;
	readonly notchTrayPinned: boolean;
}

type SettingsState = SettingsSlice & {
	readonly loaded: boolean;
	readonly setDefaultProvider: (providerId: ProviderId) => void;
	readonly setDefaultModel: (providerId: ProviderId, model: string) => void;
	readonly setDefaultProviderAndModel: (
		providerId: ProviderId,
		model: string,
	) => void;
	readonly setDefaultRuntimeMode: (mode: RuntimeMode) => void;
	readonly setDefaultAutoCreateWorktree: (value: boolean) => void;
	readonly setDefaultAutonomyLevel: (level: AutonomyLevel) => void;
	readonly setCompletionSoundEnabled: (value: boolean) => void;
	readonly setCompletionSoundPreset: (preset: CompletionSoundPreset) => void;
	readonly setAppearanceMode: (mode: AppearanceMode) => void;
	readonly setOnboardingCompleted: (value: boolean) => void;
	readonly setProviderEnabled: (providerId: ProviderId, value: boolean) => void;
	readonly setModelEnabled: (
		providerId: ProviderId,
		modelId: string,
		value: boolean,
	) => void;
	readonly addCustomModelId: (providerId: ProviderId, modelId: string) => void;
	readonly removeCustomModelId: (
		providerId: ProviderId,
		modelId: string,
	) => void;
	readonly setOpencodeProviderVisible: (
		providerId: string,
		value: boolean,
	) => void;
	readonly setOpencodeModelVisible: (
		providerId: string,
		modelId: string,
		value: boolean,
	) => void;
	readonly setBranchNamingStyle: (style: BranchNamingStyle) => void;
	readonly setBranchNamingPrefix: (prefix: string) => void;
	readonly setMergePrefs: (prefs: {
		method: GitMergeMethod;
		deleteBranch: boolean;
	}) => void;
	readonly setNotchTrayEnabled: (value: boolean) => void;
	readonly setNotchTrayPinned: (value: boolean) => void;
};

const PROVIDERS: ReadonlyArray<ProviderId> = [
	"claude",
	"codex",
	"grok",
	"cursor",
	"gemini",
	"opencode",
	"kiro",
];

const seedModels = (): Record<ProviderId, string> => ({
	claude: defaultModelFor("claude"),
	codex: defaultModelFor("codex"),
	grok: defaultModelFor("grok"),
	cursor: defaultModelFor("cursor"),
	gemini: defaultModelFor("gemini"),
	opencode: defaultModelFor("opencode"),
	kiro: defaultModelFor("kiro"),
});

const seedProviderEnabled = (): Record<ProviderId, boolean> =>
	Object.fromEntries(PROVIDERS.map((provider) => [provider, true])) as Record<
		ProviderId,
		boolean
	>;

const copyCustomModelIds = (
	input?: Partial<Record<ProviderId, ReadonlyArray<string>>>,
): Record<ProviderId, ReadonlyArray<string>> => {
	const result = {} as Record<ProviderId, ReadonlyArray<string>>;
	for (const provider of PROVIDERS) {
		result[provider] = [...(input?.[provider] ?? [])];
	}
	return result;
};

const mergeModelEnabled = (
	input: Partial<Record<ProviderId, Partial<Record<string, boolean>>>>,
): ModelEnabledByProvider => {
	const result = defaultModelEnabledByProvider();
	for (const provider of PROVIDERS) {
		for (const [model, enabled] of Object.entries(input[provider] ?? {})) {
			if (typeof enabled === "boolean") result[provider][model] = enabled;
		}
	}
	return result;
};

const FALLBACK: SettingsSlice = {
	defaultProviderId: "claude",
	defaultModelByProvider: seedModels(),
	defaultRuntimeMode: "approval-required",
	defaultAutoCreateWorktree: true,
	defaultAutonomyLevel: "approval-gated",
	completionSoundEnabled: false,
	completionSoundPreset: "chime",
	appearanceMode: "dark",
	onboardingCompleted: false,
	providerEnabled: seedProviderEnabled(),
	modelEnabledByProvider: defaultModelEnabledByProvider(),
	customModelIdsByProvider: copyCustomModelIds(),
	opencodeProviderVisible: {},
	opencodeModelVisibleByProvider: {},
	opencodeCustomProviders: [],
	branchNamingStyle: "username-slug",
	branchNamingPrefix: "",
	mergePrefs: { method: "merge", deleteBranch: false },
	notchTrayEnabled: false,
	notchTrayPinned: false,
};

const fromFile = (file: SettingsFile): SettingsSlice => {
	const models = { ...seedModels(), ...file.defaultModelByProvider };
	for (const provider of PROVIDERS) {
		models[provider] = resolveModelSlug(provider, models[provider]);
	}
	return {
		defaultProviderId: file.defaultProviderId,
		defaultModelByProvider: models,
		defaultRuntimeMode: file.defaultRuntimeMode,
		defaultAutoCreateWorktree: file.defaultAutoCreateWorktree,
		defaultAutonomyLevel: file.defaultAutonomyLevel,
		completionSoundEnabled: file.completionSoundEnabled,
		completionSoundPreset: file.completionSoundPreset,
		appearanceMode: file.appearanceMode,
		onboardingCompleted: file.onboardingCompleted,
		providerEnabled: { ...seedProviderEnabled(), ...file.providerEnabled },
		modelEnabledByProvider: mergeModelEnabled(file.modelEnabledByProvider),
		customModelIdsByProvider: copyCustomModelIds(file.customModelIdsByProvider),
		opencodeProviderVisible: { ...file.opencodeProviderVisible },
		opencodeModelVisibleByProvider: Object.fromEntries(
			Object.entries(file.opencodeModelVisibleByProvider).map(
				([key, value]) => [key, { ...value }],
			),
		),
		opencodeCustomProviders: file.opencodeCustomProviders.map((provider) => ({
			...provider,
			models: provider.models.map((model) => ({ ...model })),
		})),
		branchNamingStyle: file.branchNamingStyle,
		branchNamingPrefix: file.branchNamingPrefix,
		mergePrefs: file.mergePrefs,
		notchTrayEnabled: file.notchTrayEnabled,
		notchTrayPinned: file.notchTrayPinned,
	};
};

const keyFor = (environmentId: EnvironmentId) =>
	makeResourceKey<SettingsSlice>("environment-settings", { environmentId });

const environmentFrom = (key: ResourceKey<unknown>): EnvironmentId | null =>
	key.kind === "environment-settings" && !("sessionId" in key.ref)
		? key.ref.environmentId
		: null;

type PendingSettingsPatch = Readonly<{ id: string; patch: SettingsPatch }>;
const pendingPatches = new Map<EnvironmentId, PendingSettingsPatch[]>();
const authoritativeSettings = new Map<EnvironmentId, SettingsSlice>();

const applyPatch = (
	state: SettingsSlice,
	patch: SettingsPatch,
): SettingsSlice => ({ ...state, ...patch }) as SettingsSlice;

const withPendingPatches = (
	environmentId: EnvironmentId,
	state: SettingsSlice,
): SettingsSlice =>
	(pendingPatches.get(environmentId) ?? []).reduce(
		(current, pending) => applyPatch(current, pending.patch),
		state,
	);

const migrateLegacy = async (client: MemoizeClient): Promise<void> => {
	if (typeof window === "undefined") return;
	const settingsV1Raw = window.localStorage.getItem("memoize.settings.v1");
	const subagentsRaw = window.localStorage.getItem("memoize.subagents");
	if (settingsV1Raw !== null || subagentsRaw !== null) {
		try {
			await Effect.runPromise(
				client["settings.migrateLocalStorage"]({
					settingsV1Raw: settingsV1Raw ?? undefined,
					subagentsRaw: subagentsRaw ?? undefined,
				}),
			);
			window.localStorage.removeItem("memoize.settings.v1");
			window.localStorage.removeItem("memoize.subagents");
		} catch {}
	}
	const raw = readStorageWithLegacy(window.localStorage, "zuse.mergePrefs.v1", [
		"memoize.mergePrefs.v1",
	]);
	if (raw === null) return;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const current = await Effect.runPromise(client["settings.get"]());
		const method =
			parsed.method === "merge" ||
			parsed.method === "squash" ||
			parsed.method === "rebase"
				? parsed.method
				: current.mergePrefs.method;
		await Effect.runPromise(
			client["settings.update"]({
				patch: {
					mergePrefs: {
						method,
						deleteBranch:
							typeof parsed.deleteBranch === "boolean"
								? parsed.deleteBranch
								: current.mergePrefs.deleteBranch,
					},
				},
			}),
		);
		removeStorageKeys(window.localStorage, "zuse.mergePrefs.v1", [
			"memoize.mergePrefs.v1",
		]);
	} catch {}
};

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const makeDriver = (): ResourceDriver<MemoizeClient, SettingsSlice> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			const environmentId = environmentFrom(context.key);
			if (environmentId === null) return;
			active = true;
			const epoch = `settings:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			const program = Effect.tryPromise(() =>
				migrateLegacy(context.client),
			).pipe(
				Effect.catch(() => Effect.void),
				Effect.andThen(
					Stream.runForEach(context.client["settings.stream"](), (file) =>
						Effect.sync(() => {
							if (!active || !context.isCurrent()) return;
							const authoritative = fromFile(file);
							authoritativeSettings.set(environmentId, authoritative);
							version += 1;
							context.emit({
								data: withPendingPatches(environmentId, authoritative),
								cursor: { epoch, version },
								resetEpoch: version === 1,
								sync: "live",
							});
						}),
					),
				),
				Effect.andThen(
					Effect.fail(new Error("Settings stream ended unexpectedly")),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						context.emit({ sync: "failed" });
						getRendererClientBus().reportConnectionFault(
							environmentId,
							{ phase: "failed", message: messageOf(Cause.squash(cause)) },
							context.generation,
						);
					}),
				),
			);
			fiber = Effect.runFork(program);
		},
		stop: () => {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

registerRendererResourceDriver("environment-settings", (key) =>
	environmentFrom(key) === null
		? null
		: (makeDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const activeResource = () => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);
	return {
		environmentId,
		key: keyFor(environmentId),
		bus: getRendererClientBus(),
	};
};

const snapshot = (): SettingsSlice => {
	const { bus, key } = activeResource();
	return bus.snapshot(key)?.data ?? FALLBACK;
};

const update = (patchFor: (current: SettingsSlice) => SettingsPatch): void => {
	const { environmentId, key, bus } = activeResource();
	const current = bus.snapshot(key)?.data ?? FALLBACK;
	const patch = patchFor(current);
	const id = crypto.randomUUID();
	pendingPatches.set(environmentId, [
		...(pendingPatches.get(environmentId) ?? []),
		{ id, patch },
	]);
	bus.overlay(key, { update: (data) => applyPatch(data, patch) });
	void bus
		.dispatch<SettingsFile>({
			kind: "settings.update",
			commandId: CommandId.make(`settings-update:${id}`),
			environmentId,
			resource: key,
			payload: { patch },
			retry: "never",
			createdAt: Date.now(),
		})
		.then(
			(receipt) => {
				const authoritative = fromFile(receipt.result);
				authoritativeSettings.set(environmentId, authoritative);
				pendingPatches.set(
					environmentId,
					(pendingPatches.get(environmentId) ?? []).filter(
						(pending) => pending.id !== id,
					),
				);
				bus.overlay(key, {
					update: () => withPendingPatches(environmentId, authoritative),
				});
			},
			() => {
				pendingPatches.set(
					environmentId,
					(pendingPatches.get(environmentId) ?? []).filter(
						(pending) => pending.id !== id,
					),
				);
				bus.overlay(key, {
					update: () =>
						withPendingPatches(
							environmentId,
							authoritativeSettings.get(environmentId) ?? FALLBACK,
						),
				});
			},
		);
};

const ACTIONS = {
	setDefaultProvider: (defaultProviderId: ProviderId) =>
		update((state) => ({
			defaultProviderId,
			defaultRuntimeMode: runtimeModeForProvider(
				state.defaultRuntimeMode,
				defaultProviderId,
			),
		})),
	setDefaultModel: (providerId: ProviderId, model: string) =>
		update((state) => ({
			defaultModelByProvider: {
				...state.defaultModelByProvider,
				[providerId]: model,
			},
		})),
	setDefaultProviderAndModel: (providerId: ProviderId, model: string) =>
		update((state) => ({
			defaultProviderId: providerId,
			defaultRuntimeMode: runtimeModeForProvider(
				state.defaultRuntimeMode,
				providerId,
			),
			defaultModelByProvider: {
				...state.defaultModelByProvider,
				[providerId]: model,
			},
		})),
	setDefaultRuntimeMode: (defaultRuntimeMode: RuntimeMode) =>
		update((state) => ({
			defaultRuntimeMode: runtimeModeForProvider(
				defaultRuntimeMode,
				state.defaultProviderId,
			),
		})),
	setDefaultAutoCreateWorktree: (defaultAutoCreateWorktree: boolean) =>
		update(() => ({ defaultAutoCreateWorktree })),
	setDefaultAutonomyLevel: (defaultAutonomyLevel: AutonomyLevel) =>
		update(() => ({ defaultAutonomyLevel })),
	setCompletionSoundEnabled: (completionSoundEnabled: boolean) =>
		update(() => ({ completionSoundEnabled })),
	setCompletionSoundPreset: (completionSoundPreset: CompletionSoundPreset) =>
		update(() => ({ completionSoundPreset })),
	setAppearanceMode: (appearanceMode: AppearanceMode) =>
		update(() => ({ appearanceMode })),
	setOnboardingCompleted: (onboardingCompleted: boolean) =>
		update(() => ({ onboardingCompleted })),
	setProviderEnabled: (providerId: ProviderId, value: boolean) =>
		update((state) => ({
			providerEnabled: { ...state.providerEnabled, [providerId]: value },
		})),
	setModelEnabled: (providerId: ProviderId, modelId: string, value: boolean) =>
		update((state) => ({
			modelEnabledByProvider: {
				...state.modelEnabledByProvider,
				[providerId]: {
					...state.modelEnabledByProvider[providerId],
					[modelId]: value,
				},
			},
		})),
	addCustomModelId: (providerId: ProviderId, modelId: string) =>
		update((state) => ({
			customModelIdsByProvider: {
				...state.customModelIdsByProvider,
				[providerId]: [
					...new Set([...state.customModelIdsByProvider[providerId], modelId]),
				],
			},
		})),
	removeCustomModelId: (providerId: ProviderId, modelId: string) =>
		update((state) => ({
			customModelIdsByProvider: {
				...state.customModelIdsByProvider,
				[providerId]: state.customModelIdsByProvider[providerId].filter(
					(id) => id !== modelId,
				),
			},
		})),
	setOpencodeProviderVisible: (providerId: string, value: boolean) =>
		update((state) => ({
			opencodeProviderVisible: {
				...state.opencodeProviderVisible,
				[providerId]: value,
			},
		})),
	setOpencodeModelVisible: (
		providerId: string,
		modelId: string,
		value: boolean,
	) =>
		update((state) => ({
			opencodeModelVisibleByProvider: {
				...state.opencodeModelVisibleByProvider,
				[providerId]: {
					...state.opencodeModelVisibleByProvider[providerId],
					[modelId]: value,
				},
			},
		})),
	setBranchNamingStyle: (branchNamingStyle: BranchNamingStyle) =>
		update(() => ({ branchNamingStyle })),
	setBranchNamingPrefix: (branchNamingPrefix: string) =>
		update(() => ({ branchNamingPrefix })),
	setMergePrefs: (mergePrefs: {
		method: GitMergeMethod;
		deleteBranch: boolean;
	}) => update(() => ({ mergePrefs })),
	setNotchTrayEnabled: (notchTrayEnabled: boolean) =>
		update(() => ({ notchTrayEnabled })),
	setNotchTrayPinned: (notchTrayPinned: boolean) =>
		update(() => ({ notchTrayPinned })),
};

const state = (): SettingsState => ({
	...snapshot(),
	...ACTIONS,
	loaded: true,
});

type SettingsHook = {
	<Selected>(selector: (state: SettingsState) => Selected): Selected;
	getState: () => SettingsState;
};

export const useSettingsStore: SettingsHook = Object.assign(
	<Selected>(selector: (state: SettingsState) => Selected): Selected => {
		const environmentId = EnvironmentId.make(
			useEnvironmentCatalogStore((catalog) => catalog.activeEnvironmentId),
		);
		const key = useMemo(() => keyFor(environmentId), [environmentId]);
		const bus = getRendererClientBus();
		useEffect(
			() => bus.retain(key, { activation: "connect" }).release,
			[bus, key],
		);
		const view = useSyncExternalStore(
			(listener) => bus.subscribe(key, listener),
			() => bus.snapshot(key),
		);
		return selector({
			...(view.data ?? FALLBACK),
			...ACTIONS,
			loaded: view.data !== null,
		});
	},
	{ getState: state },
);
