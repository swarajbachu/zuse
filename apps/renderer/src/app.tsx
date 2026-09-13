import { SurfaceFallback } from "./shell/surface-fallback.tsx";
import "@zuse/i18n/english/shell";

import { Effect } from "effect";

import { lazy, Suspense, useEffect } from "react";

import { TooltipProvider } from "./components/ui/tooltip.tsx";

import { useKeybindingDispatch } from "./hooks/use-keybinding-dispatch.ts";

import { useMenuShortcuts } from "./hooks/use-menu-shortcuts.ts";

import { useReportRuntimeActivity } from "./hooks/use-report-runtime-activity.ts";

import {
	startDesktopAnalytics,
	trackAnalyticsScreen,
} from "./lib/analytics.ts";

import { AppearanceController } from "./lib/appearance.tsx";

import { installClientBusOnlineBridge } from "./lib/client-bus-online.ts";
import { ExtensionHostController } from "./lib/extension-registry.tsx";
import { markRendererStartupMilestone } from "./lib/performance-marks.ts";

import { installQueueOnlineRecovery } from "./lib/queue-recovery.ts";

import { getRpcClient } from "./lib/rpc-client.ts";

import { useSettingsStore } from "./lib/settings-client-bus.ts";

import { useUiStore } from "./store/ui.ts";

const ExtensionSurfaceHost = lazy(() =>
	import("./lib/extension-surfaces.tsx").then((module) => ({
		default: module.ExtensionSurfaceHost,
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

const SettingsPage = lazy(() =>
	import("./components/settings-page.tsx").then((module) => ({
		default: module.SettingsPage,
	})),
);

const loadUsageDashboard = () => import("./components/usage-dashboard.tsx");

function AmbientSurfaces() {
	return (
		<Suspense fallback={null}>
			<NotchTrayBridge />
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
export function App() {
	const onboardingCompleted = useSettingsStore(
		(state) => state.onboardingCompleted,
	);
	return (
		<>
			<ExtensionHostController />
			<Suspense fallback={null}>
				<ExtensionSurfaceHost />
			</Suspense>
			<ReadyApp onboardingCompleted={onboardingCompleted} />
		</>
	);
}

function ReadyApp({
	onboardingCompleted,
}: {
	readonly onboardingCompleted: boolean;
}) {
	useEffect(() => installClientBusOnlineBridge(), []);
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

	// Mirror privacy-safe agent, terminal, browser, recording, and indexing
	// counts to desktop services. The agent count also powers quit deferrals.
	useReportRuntimeActivity();

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
				<AmbientSurfaces />
				<AppearanceController />
				<div className="relative flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden bg-background text-foreground">
					<Suspense fallback={<SurfaceFallback />}>
						<OnboardingWizard />
					</Suspense>
				</div>
			</TooltipProvider>
		);
	}

	if (view === "settings") {
		return (
			<TooltipProvider>
				<AmbientSurfaces />
				<AppearanceController />
				<div className="flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden bg-background text-foreground">
					<Suspense fallback={<SurfaceFallback />}>
						<SettingsPage />
					</Suspense>
				</div>
			</TooltipProvider>
		);
	}

	return (
		<TooltipProvider>
			<AmbientSurfaces />
			<AppearanceController />
			<Suspense fallback={<SurfaceFallback />}>
				<MainShell />
			</Suspense>
		</TooltipProvider>
	);
}
const MainShell = lazy(() =>
	import("./shell/main-shell.tsx").then((module) => ({
		default: module.MainShell,
	})),
);
