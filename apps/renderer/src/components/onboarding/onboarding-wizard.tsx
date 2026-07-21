import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
} from "@hugeicons-pro/core-stroke-rounded";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useProvidersStore } from "../../store/providers.ts";
import { useSettingsStore } from "../../store/settings.ts";
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

	const stepId = STEPS[stepIndex]!;
	const isFirst = stepIndex === 0;
	const isLast = stepId === "done";

	const canAdvance = useMemo(() => {
		if (stepId === "project") return folders.length > 0;
		return true;
	}, [stepId, folders.length]);

	const goNext = useCallback(() => {
		setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
	}, []);
	const goBack = useCallback(() => {
		setStepIndex((i) => Math.max(i - 1, 0));
	}, []);
	const finish = useCallback(() => {
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
		<div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
			{/* Ambient color: two soft radial blooms behind a heavy blur for that
          frosted-vibrancy feel. Sits behind the card, never interactive. */}
			<div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
				<div className="absolute -top-32 -left-24 size-[28rem] rounded-full bg-[radial-gradient(circle_at_center,theme(colors.indigo.500/0.18),transparent_70%)] blur-3xl" />
				<div className="absolute -bottom-40 -right-20 size-[32rem] rounded-full bg-[radial-gradient(circle_at_center,theme(colors.fuchsia.500/0.14),transparent_70%)] blur-3xl" />
				<div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,theme(colors.white/0.04),transparent_60%)]" />
			</div>

			{/* Drag region so users can move the Electron window. */}
			<div className="h-9 shrink-0 [-webkit-app-region:drag]" />

			<div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-12">
				<div className="flex w-full max-w-xl flex-col gap-6">
					<StepIndicator stepIndex={stepIndex} />

					<div className="min-h-[24rem] px-1 py-2">
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
								variant="ghost"
								size="sm"
								onClick={goBack}
								disabled={isFirst}
								className={cn(
									"rounded-lg px-3 text-muted-foreground hover:text-foreground",
									isFirst && "invisible",
								)}
							>
								<HugeiconsIcon icon={ArrowLeft01Icon} />
								Back
							</Button>
							<div className="flex items-center gap-1">
								{skippable && (
									<Button
										variant="ghost"
										size="sm"
										onClick={goNext}
										className="rounded-lg px-3 text-muted-foreground hover:text-foreground"
									>
										Skip
									</Button>
								)}
								<Button
									size="default"
									onClick={goNext}
									disabled={!canAdvance}
									className="rounded-lg px-5"
								>
									{isFirst ? "Get started" : "Continue"}
									<HugeiconsIcon icon={ArrowRight01Icon} />
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
		<div className="flex items-center justify-center gap-1.5">
			{STEPS.map((id, i) => {
				const active = i === stepIndex;
				const done = i < stepIndex;
				return (
					<span
						key={id}
						className={cn(
							"h-1 rounded-full transition-all duration-300",
							active && "w-8 bg-foreground",
							done && "w-4 bg-foreground/60",
							!active && !done && "w-4 bg-foreground/15",
						)}
					/>
				);
			})}
		</div>
	);
}
