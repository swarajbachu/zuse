import "@zuse/i18n/english/onboarding";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { captureAnalytics } from "~/lib/analytics";
import { cn } from "~/lib/utils";
import { useSettingsStore } from "../../lib/settings-client-bus.ts";
import { useProvidersStore } from "../../store/providers.ts";
import { useWorkspaceStore } from "../../store/workspace.ts";
import { AppearanceStep } from "./steps/appearance.tsx";
import { DefaultsStep } from "./steps/defaults.tsx";
import { DoneStep } from "./steps/done.tsx";
import { MaximizeStep } from "./steps/maximize.tsx";
import { ProjectStep } from "./steps/project.tsx";
import { ProviderStep } from "./steps/provider.tsx";
import { SigninStep } from "./steps/signin.tsx";
import { WelcomeStep } from "./steps/welcome.tsx";

type StepId =
	| "welcome"
	| "signin"
	| "maximize"
	| "provider"
	| "project"
	| "appearance"
	| "defaults"
	| "done";

const STEPS: ReadonlyArray<StepId> = [
	"welcome",
	"maximize",
	"provider",
	"project",
	"appearance",
	"defaults",
	"signin",
	"done",
];

/**
 * First-launch wizard. Mounted at the top of `App` when
 * `settings.onboardingCompleted === false`. Hydrates providers + workspace
 * once on mount so the Provider and Project steps render fresh state.
 */
export function OnboardingWizard() {
	const { message: uiMessage } = useUiMessages(["common", "onboarding"]);

	const loadProviders = useProvidersStore((s) => s.load);
	const loadWorkspace = useWorkspaceStore((s) => s.load);
	const folders = useWorkspaceStore((s) => s.folders);
	const setOnboardingCompleted = useSettingsStore(
		(s) => s.setOnboardingCompleted,
	);

	const [stepIndex, setStepIndex] = useState(0);

	useEffect(() => {
		void loadProviders();
		void loadWorkspace();
	}, [loadProviders, loadWorkspace]);

	const stepId = STEPS[stepIndex] ?? "welcome";
	const isFirst = stepIndex === 0;
	const isLast = stepId === "done";

	const canAdvance = useMemo(() => {
		if (stepId === "project") return folders.length > 0;
		return true;
	}, [stepId, folders.length, uiMessage]);

	useEffect(() => {
		captureAnalytics("onboarding step viewed", { step: stepId });
	}, [stepId]);

	const goNext = useCallback(() => {
		captureAnalytics("onboarding step completed", { step: stepId });
		setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
	}, [stepId]);
	const goBack = useCallback(() => {
		setStepIndex((i) => Math.max(i - 1, 0));
	}, []);
	const finish = useCallback(() => {
		captureAnalytics("onboarding completed");
		setOnboardingCompleted(true);
	}, [setOnboardingCompleted]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!e.metaKey && !e.ctrlKey) return;
			if (e.key === "ArrowLeft" && !isFirst) {
				e.preventDefault();
				goBack();
			} else if (e.key === "ArrowRight" && !isLast && canAdvance) {
				e.preventDefault();
				goNext();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isFirst, isLast, canAdvance, goBack, goNext]);

	const skippable =
		stepId === "signin" || stepId === "project" || stepId === "defaults";

	return (
		<div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
			{/* Drag region so users can move the Electron window. */}
			<div className="h-8 shrink-0 [-webkit-app-region:drag]" />

			<div className="flex min-h-0 flex-1 overflow-y-auto px-5 pb-8">
				<div className="m-auto flex w-full max-w-xl shrink-0 flex-col gap-4">
					<StepIndicator stepIndex={stepIndex} />

					<div
						key={stepId}
						className="compact-step-enter min-h-[20rem] px-1 py-1.5"
					>
						{stepId === "welcome" && <WelcomeStep />}
						{stepId === "signin" && <SigninStep />}
						{stepId === "maximize" && <MaximizeStep />}
						{stepId === "provider" && <ProviderStep />}
						{stepId === "project" && <ProjectStep />}
						{stepId === "appearance" && <AppearanceStep />}
						{stepId === "defaults" && <DefaultsStep />}
						{stepId === "done" && <DoneStep onFinish={finish} />}
					</div>

					{!isLast && (
						<div className="flex items-center justify-between">
							<Button
								data-analytics-id="onboarding.back"
								variant="ghost"
								size="sm"
								onClick={goBack}
								disabled={isFirst}
								className={cn(
									"px-2.5 text-muted-foreground hover:text-foreground",
									isFirst && "invisible",
								)}
							>
								<ChevronLeft />
								{uiMessage("common:back")}
							</Button>
							<div className="flex items-center gap-1">
								{skippable && (
									<Button
										data-analytics-id="onboarding.skip"
										variant="ghost"
										size="sm"
										onClick={goNext}
										className="px-2.5 text-muted-foreground hover:text-foreground"
									>
										{uiMessage("onboarding:onboarding_wizard_skip")}
									</Button>
								)}
								<Button
									data-analytics-id="onboarding.continue"
									size="default"
									onClick={goNext}
									disabled={!canAdvance}
									className="px-4"
								>
									{isFirst
										? uiMessage("onboarding:onboarding_wizard_get_started")
										: uiMessage("common:continue")}
									<ChevronRight />
								</Button>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function StepIndicator({ stepIndex }: { stepIndex: number }) {
	return (
		<div className="flex items-center justify-center gap-1">
			{STEPS.map((id, i) => {
				const active = i === stepIndex;
				const done = i < stepIndex;
				return (
					<span
						key={id}
						className={cn(
							"h-0.5 rounded-full transition-[width,background-color] duration-180",
							active && "w-6 bg-foreground",
							done && "w-3 bg-foreground/60",
							!active && !done && "w-3 bg-foreground/15",
						)}
					/>
				);
			})}
		</div>
	);
}
