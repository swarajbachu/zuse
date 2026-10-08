import { useCloudOnboarding } from "./hooks/use-cloud-onboarding.ts";
import { SurfaceFallback } from "./shell/surface-fallback.tsx";
import "@zuse/i18n/english/shell";

import { Effect } from "effect";

import { lazy, Suspense, useEffect, useRef, useSyncExternalStore } from "react";

import { TooltipProvider } from "./components/ui/tooltip-provider.tsx";
import { useAuth } from "./hooks/use-auth.ts";
import { useKeybindingDispatch } from "./hooks/use-keybinding-dispatch.ts";

import { useMenuShortcuts } from "./hooks/use-menu-shortcuts.ts";

import {
	startDesktopAnalytics,
	trackAnalyticsScreen,
} from "./lib/analytics.ts";

import { AppearanceController } from "./lib/appearance.tsx";

import {
	installClientBusOnlineBridge,
	installConnectionWakeups,
} from "./lib/client-bus-online.ts";
import { prefetchCloudWorkspaceSession } from "./lib/cloud-workspace-session-cache.ts";
import {
	clearControlPlaneSessionCache,
	setControlPlaneCacheAccount,
} from "./lib/control-plane-client.ts";

import { useOrganizationWorkspaces } from "./lib/organization-workspaces.ts";
import { markRendererStartupMilestone } from "./lib/performance-marks.ts";
import { isHostedProduct } from "./lib/platform-capabilities.ts";
import { installQueueOnlineRecovery } from "./lib/queue-recovery.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "./lib/renderer-workspace.ts";

import { getRpcClient } from "./lib/rpc-client.ts";

import { useSettingsStore } from "./lib/settings-client-bus.ts";

import { useEnvironmentCatalogStore } from "./store/environment-catalog.ts";
import { useModelCatalogStore } from "./store/model-catalog.ts";
import { useProvidersStore } from "./store/providers.ts";

import { useUiStore } from "./store/ui.ts";

import { useWorkspaceStore } from "./store/workspace.ts";

// Build monitoring starts after account access is ready and needs no startup UI.
const CloudBuildMonitor = lazy(() =>
	import("./components/cloud-build-monitor.tsx").then((module) => ({
		default: module.CloudBuildMonitor,
	})),
);

const ModelCatalogUpdates = lazy(() =>
	import("./hooks/use-model-catalog-updates.ts").then((module) => ({
		default: module.ModelCatalogUpdates,
	})),
);

const PrWatchController = lazy(() =>
	import("./components/pr-watch-controller.tsx").then((module) => ({
		default: module.PrWatchController,
	})),
);

const RuntimeActivityReporter = lazy(() =>
	import("./hooks/use-report-runtime-activity.ts").then((module) => ({
		default: module.RuntimeActivityReporter,
	})),
);

const NearbyPairingApproval = lazy(() =>
	import("./components/nearby-pairing-approval.tsx").then((module) => ({
		default: module.NearbyPairingApproval,
	})),
);

const NotchTrayBridge = lazy(() =>
	import("./components/notch-tray-bridge.tsx").then((module) => ({
		default: module.NotchTrayBridge,
	})),
);

const PairingLinkAccept = lazy(() =>
	import("./components/pairing-link-accept.tsx").then((module) => ({
		default: module.PairingLinkAccept,
	})),
);

const OnboardingWizard = lazy(() =>
	import("./components/onboarding/onboarding-wizard.tsx").then((module) => ({
		default: module.OnboardingWizard,
	})),
);

const CloudOnboardingWizard = lazy(() =>
	import("./components/onboarding/cloud-onboarding-wizard.tsx").then(
		(module) => ({ default: module.CloudOnboardingWizard }),
	),
);

const SettingsPage = lazy(() =>
	import("./components/settings-page.tsx").then((module) => ({
		default: module.SettingsPage,
	})),
);

const loadUsageDashboard = () => import("./components/usage-dashboard.tsx");

const ChatSwitcher = lazy(() =>
	import("./components/chat-switcher.tsx").then((module) => ({
		default: module.ChatSwitcher,
	})),
);

const LazyPluginReturnHandler = lazy(() =>
	import("./components/plugin-return-handler.tsx").then((module) => ({
		default: module.PluginReturnHandler,
	})),
);

// Plugin callbacks run across every surface without making their client and
// schemas part of the shell's static startup graph.
function PluginReturnHandler() {
	return (
		<Suspense fallback={null}>
			<LazyPluginReturnHandler />
		</Suspense>
	);
}

function AmbientSurfaces() {
	const chatSwitcherOpen = useUiStore((state) => state.chatSwitcherOpen);
	return (
		<Suspense fallback={null}>
			<RuntimeActivityReporter />
			{chatSwitcherOpen ? <ChatSwitcher /> : null}
			<NotchTrayBridge />
			<PrWatchController />
			<NearbyPairingApproval />
			<PairingLinkAccept />
		</Suspense>
	);
}

/**
 * Owns cross-cutting concerns only after settings are available. Deferring
 * these subscriptions keeps the startup surface cheap and prevents fallback
 * settings from being observed as real product state.
 */
export function App({ onReady }: { readonly onReady?: () => void }) {
	const { isSignedIn, user } = useAuth();
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
	);
	const organizationId =
		workspace.scope.kind === "organization"
			? workspace.scope.organizationId
			: null;
	const organization = useOrganizationWorkspaces((state) =>
		organizationId !== null
			? state.organizations.find((org) => org.id === organizationId)
			: undefined,
	);
	const canConfigureCloud =
		workspace.scope.kind === "personal" || organization?.role === "admin";
	const onboardingOwner =
		user === null || user === undefined
			? null
			: workspace.scope.kind === "personal"
				? user.id
				: JSON.stringify([user.id, workspace.key]);
	const onboardingCompleted = useSettingsStore(
		(state) => state.onboardingCompleted,
	);
	const cloudOnboarding = useCloudOnboarding(
		isSignedIn ? onboardingOwner : null,
		onboardingCompleted && canConfigureCloud,
	);
	return (
		<>
			{!isHostedProduct() && onboardingCompleted ? (
				<Suspense fallback={null}>
					<ModelCatalogUpdates />
				</Suspense>
			) : null}
			<ReadyApp
				onboardingCompleted={isHostedProduct() || onboardingCompleted}
				onReady={onReady}
				cloudOnboarding={cloudOnboarding}
			/>
			{onboardingCompleted && canConfigureCloud ? (
				<Suspense fallback={null}>
					<CloudBuildMonitor key={workspace.key} />
				</Suspense>
			) : null}
		</>
	);
}

function StartupReadySignal({
	onReady,
	ready = true,
}: {
	readonly onReady?: () => void;
	readonly ready?: boolean;
}) {
	useEffect(() => {
		if (ready) onReady?.();
	}, [onReady, ready]);
	return null;
}

function ReadyApp({
	cloudOnboarding,
	onboardingCompleted,
	onReady,
}: {
	readonly cloudOnboarding: ReturnType<typeof useCloudOnboarding>;
	readonly onboardingCompleted: boolean;
	readonly onReady?: () => void;
}) {
	const { isSignedIn, user } = useAuth();
	const cloudCacheIdentity = useRef<string | null | undefined>(undefined);
	const ensureModelCatalog = useModelCatalogStore(
		(state) => state.ensureLoaded,
	);
	const loadProviderAvailability = useProvidersStore((state) => state.load);
	useEffect(() => installClientBusOnlineBridge(), []);
	useEffect(
		() =>
			installConnectionWakeups(() => {
				const catalog = useEnvironmentCatalogStore.getState();
				if (!catalog.initialized) return;
				void catalog.syncAccountEnvironments().catch(() => undefined);
			}),
		[],
	);
	useEffect(() => installQueueOnlineRecovery(), []);
	useEffect(() => {
		let stop: (() => void) | undefined;
		void startDesktopAnalytics().then((cleanup) => {
			stop = cleanup;
		});
		return () => stop?.();
	}, []);
	// Native Application Menu → renderer action dispatcher. Lives on the
	// root so the bindings work in every view (chat, settings, onboarding).
	useMenuShortcuts();

	// Document-level keybinding dispatcher. Walks the live keybindings store
	// on every keydown and fires the matching application command. Composer
	// and editor commands are handled by CodeMirror keymaps, so this hook
	// ignores them.
	useKeybindingDispatch();

	// Warm the analytics surface after the shell settles so opening Usage never
	// pauses on parsing the chart renderer. The data request still starts only
	// when the user opens the surface.
	useEffect(() => {
		const timeout = window.setTimeout(() => void loadUsageDashboard(), 1_500);
		return () => window.clearTimeout(timeout);
	}, []);

	// Mirror Electron's fullscreen state into the ui store so the top bars
	// can drop the macOS traffic-light gutter.
	const setFullScreen = useUiStore((s) => s.setFullScreen);
	useEffect(() => {
		const win = window.zuse?.window;
		if (win === undefined) return;
		return win.onFullScreenChange((value) => setFullScreen(value));
	}, [setFullScreen]);

	// One-shot RPC ping so we know the bridge is alive early. Only the failure
	// is logged — the success path is silent to keep the renderer console clean.
	useEffect(() => {
		if (isHostedProduct()) return;
		let cancelled = false;
		void (async () => {
			try {
				const client = await getRpcClient();
				await Effect.runPromise(client["ping.ping"]({}));
				markRendererStartupMilestone("rpc-connected");
			} catch (error) {
				if (cancelled) return;
				// eslint-disable-next-line no-console
				console.error("[zuse] RPC smoke test failed:", error);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const view = useUiStore((s) => s.view);
	const activeMainTab = useUiStore((s) => s.activeMainTab);
	const initializeEnvironmentCatalog = useEnvironmentCatalogStore(
		(state) => state.initialize,
	);
	const catalogInitialized = useEnvironmentCatalogStore(
		(state) => state.initialized,
	);
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const catalogInitializationError = useEnvironmentCatalogStore(
		(state) => state.initializationError,
	);
	const projectsLoading = useWorkspaceStore((state) => state.loading);
	const desktopCatalogEnabled = window.zuse?.ssh !== undefined;
	useEffect(() => {
		if (!onboardingCompleted || !desktopCatalogEnabled) return;
		void initializeEnvironmentCatalog().catch((cause) =>
			console.error("[zuse] environment catalog initialize failed", cause),
		);
	}, [
		desktopCatalogEnabled,
		initializeEnvironmentCatalog,
		onboardingCompleted,
	]);
	useEffect(() => {
		if (isHostedProduct() || !onboardingCompleted || !catalogInitialized)
			return;
		void ensureModelCatalog().catch((cause) =>
			console.error("[zuse] model catalog prefetch failed", cause),
		);
		void loadProviderAvailability().catch((cause) =>
			console.error("[zuse] provider availability prefetch failed", cause),
		);
	}, [
		activeEnvironmentId,
		catalogInitialized,
		ensureModelCatalog,
		loadProviderAvailability,
		onboardingCompleted,
	]);
	useEffect(() => {
		if (!onboardingCompleted) return;
		const identity = user?.id ?? null;
		setControlPlaneCacheAccount(identity);
		if (cloudCacheIdentity.current !== identity) {
			clearControlPlaneSessionCache("cloud-workspace:");
			cloudCacheIdentity.current = identity;
		}
		if (!isSignedIn) {
			return;
		}
		void prefetchCloudWorkspaceSession().catch((cause) =>
			console.error("[zuse] cloud workspace prefetch failed", cause),
		);
	}, [isSignedIn, onboardingCompleted, user?.id]);
	useEffect(() => {
		trackAnalyticsScreen(
			onboardingCompleted
				? view === "settings"
					? "settings"
					: activeMainTab
				: "onboarding",
		);
	}, [activeMainTab, onboardingCompleted, view]);

	if (!onboardingCompleted) {
		return (
			<TooltipProvider>
				{!isHostedProduct() && <AmbientSurfaces />}
				<AppearanceController />
				<PluginReturnHandler />
				<div className="relative flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden bg-background text-foreground">
					<Suspense fallback={<SurfaceFallback />}>
						<OnboardingWizard />
						<StartupReadySignal onReady={onReady} />
					</Suspense>
				</div>
			</TooltipProvider>
		);
	}

	if (cloudOnboarding.open) {
		return (
			<TooltipProvider>
				<AppearanceController />
				<PluginReturnHandler />
				<div className="relative z-50 flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden bg-background text-foreground">
					<Suspense fallback={<SurfaceFallback />}>
						<CloudOnboardingWizard
							key={user?.id}
							onFinish={() => {
								cloudOnboarding.finish();
								useUiStore.getState().setView("chat");
							}}
							onDefer={cloudOnboarding.defer}
						/>
						<StartupReadySignal onReady={onReady} />
					</Suspense>
				</div>
			</TooltipProvider>
		);
	}

	if (view === "settings") {
		return (
			<TooltipProvider>
				{!isHostedProduct() && <AmbientSurfaces />}
				<AppearanceController />
				<PluginReturnHandler />
				<div className="flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden bg-background text-foreground">
					<Suspense fallback={<SurfaceFallback />}>
						<SettingsPage />
						<StartupReadySignal onReady={onReady} />
					</Suspense>
				</div>
			</TooltipProvider>
		);
	}

	return (
		<TooltipProvider>
			{!isHostedProduct() && <AmbientSurfaces />}
			<AppearanceController />
			<PluginReturnHandler />
			<Suspense fallback={<SurfaceFallback />}>
				<MainShell />
				<StartupReadySignal
					onReady={onReady}
					ready={
						!desktopCatalogEnabled ||
						((catalogInitialized || catalogInitializationError !== null) &&
							!projectsLoading)
					}
				/>
			</Suspense>
		</TooltipProvider>
	);
}
const MainShell = lazy(() =>
	import("./shell/main-shell.tsx").then((module) => ({
		default: module.MainShell,
	})),
);
