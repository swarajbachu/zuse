import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import { EnvironmentId, type MasterSnapshot } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Cancel01Icon } from "@zuse/icons/solid-rounded";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { cn } from "~/lib/utils";
import {
	canInsertZotExample,
	findZotGuideTarget,
	insertZotExample,
	leaseDetailsPanel,
	restoreZotGuideFocus,
	ZOT_GUIDE_TARGETS,
	type ZotExampleBrief,
	zotGuideVisible,
} from "../../lib/zot-guide.ts";
import { useComposerBridge } from "../../store/composer-bridge.ts";
import { composerDraftKeyForSession } from "../../store/composer-drafts.ts";
import { useMastersStore } from "../../store/masters.ts";
import {
	useZotOnboardingStore,
	ZOT_ONBOARDING_STEPS,
	type ZotOnboardingStep,
} from "../../store/zot-onboarding.ts";
import { Button } from "../ui/button.tsx";
import { Popover, PopoverPopup, PopoverTitle } from "../ui/popover.tsx";

const ACTIVE_ATTRIBUTE = "data-zot-guide-active";

const FALLBACK_PLACEMENT = { side: "bottom", align: "center" } as const;

/** Card placement next to each target; the positioner flips on collision. */
const PLACEMENT: Record<
	ZotOnboardingStep,
	{ side: "top" | "bottom" | "left"; align: "start" | "center" | "end" }
> = {
	welcome: { side: "bottom", align: "start" },
	repositories: { side: "left", align: "start" },
	brief: { side: "top", align: "center" },
	slaves: { side: "left", align: "center" },
	continuity: { side: "bottom", align: "end" },
};

/**
 * Step-by-step introduction for a Zot surface. It only points at controls
 * and explains them: nothing here runs commands, sends messages, or changes
 * repositories or permissions. Mounted once the Zot's snapshot has loaded.
 */
export function ZotGuide({
	rootRef,
	snapshot,
	environmentId,
	composerMounted,
}: {
	/** The Zot surface; targets are looked up inside it only. */
	readonly rootRef: RefObject<HTMLElement | null>;
	readonly snapshot: MasterSnapshot;
	readonly environmentId: string;
	/** Whether the coordinator conversation (with its composer) is on screen. */
	readonly composerMounted: boolean;
}) {
	const open = useZotOnboardingStore((state) => state.open);
	const step = useZotOnboardingStore((state) => state.step);
	const bridgeDraftKey = useComposerBridge((state) => state.draftKey);
	const session = snapshot.coordinator;
	const draftKey = session
		? composerDraftKeyForSession({
				environmentId: EnvironmentId.make(environmentId),
				sessionId: session.id,
			})
		: null;
	// Open at mount means automatic (first use or resume); once shown, later
	// opens (replay) no longer wait for the composer.
	// State, not a ref: a render React discards must not mark the guide shown.
	const [settled, setSettled] = useState(!open);
	const visible = zotGuideVisible({
		open,
		waitForComposer: !settled && composerMounted,
		draftKey,
		bridgeDraftKey,
	});
	useEffect(() => {
		if (visible) setSettled(true);
	}, [visible]);
	const target = useGuideTarget(rootRef, visible ? step : null);
	useDetailsLease(visible);
	useFocusReturn(rootRef, visible, draftKey);

	if (!visible) return null;
	return (
		<ZotGuideCard
			step={step}
			snapshot={snapshot}
			draftKey={draftKey}
			anchor={target ?? fallbackAnchor(rootRef)}
			anchored={target !== null}
		/>
	);
}

/** When the card closes and focus fell to the page, put it somewhere useful. */
function useFocusReturn(
	rootRef: RefObject<HTMLElement | null>,
	visible: boolean,
	draftKey: string | null,
) {
	const shown = useRef(false);
	useEffect(() => {
		if (visible) {
			shown.current = true;
			return;
		}
		if (!shown.current) return;
		shown.current = false;
		const active = document.activeElement;
		restoreZotGuideFocus(
			!active || active === document.body || !active.isConnected,
			rootRef.current,
			useComposerBridge.getState(),
			draftKey,
		);
	}, [rootRef, visible, draftKey]);
}

/** Tracks the marked control for `step` as panels mount, slide or hide. */
function useGuideTarget(
	rootRef: RefObject<HTMLElement | null>,
	step: ZotOnboardingStep | null,
) {
	const [element, setElement] = useState<Element | null>(null);
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root || step === null) {
			setElement(null);
			return;
		}
		const target = ZOT_GUIDE_TARGETS[step];
		let frame = 0;
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() =>
				setElement(findZotGuideTarget(root, target)),
			);
		};
		setElement(findZotGuideTarget(root, target));
		const observer = new MutationObserver(update);
		observer.observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["inert", "hidden"],
		});
		window.addEventListener("resize", update);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [rootRef, step]);
	useEffect(() => {
		element?.setAttribute(ACTIVE_ATTRIBUTE, "");
		return () => element?.removeAttribute(ACTIVE_ATTRIBUTE);
	}, [element]);
	return element;
}

/** Shows Details for the whole guide; restores it if the guide opened it. */
function useDetailsLease(active: boolean) {
	useEffect(() => {
		if (!active) return;
		const lease = leaseDetailsPanel(useMastersStore);
		lease.acquire();
		return lease.release;
	}, [active]);
}

/**
 * Without a visible target the card sits below the top of the conversation
 * column (or the whole surface before that column mounts).
 */
const fallbackAnchor = (rootRef: RefObject<HTMLElement | null>) => ({
	getBoundingClientRect: () => {
		const root = rootRef.current;
		const area = root?.querySelector("[data-zot-guide-area]") ?? root;
		const rect = area?.getBoundingClientRect();
		const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
		const y = rect ? rect.top + 24 : 72;
		return new DOMRect(x, y, 0, 0);
	},
});

/**
 * Inserts an example brief into this Zot's own composer as editable text, or
 * `null` when that composer isn't mounted. Nothing is ever sent.
 */
export function useZotExample(
	draftKey: string | null,
): ((example: ZotExampleBrief) => void) | null {
	const { message } = useMessages("projects");
	const bridge = useComposerBridge();
	if (!canInsertZotExample(bridge, draftKey)) return null;
	return (example) => {
		insertZotExample(
			bridge,
			draftKey,
			message(`projects:masters_guide_example_${example}_text`),
		);
		bridge.focus?.();
	};
}

function ZotGuideCard({
	step,
	snapshot,
	draftKey,
	anchor,
	anchored,
}: {
	readonly step: ZotOnboardingStep;
	readonly snapshot: MasterSnapshot;
	/** This Zot's coordinator composer draft key, if it has a session. */
	readonly draftKey: string | null;
	readonly anchor: Element | { getBoundingClientRect: () => DOMRect };
	/** Whether `anchor` is the step's own control rather than the fallback. */
	readonly anchored: boolean;
}) {
	const guide = useZotOnboardingStore();
	const tryExample = useZotExample(draftKey);
	const primary = useRef<HTMLButtonElement>(null);
	const placement = anchored ? PLACEMENT[step] : FALLBACK_PLACEMENT;
	return (
		<Popover
			open
			onOpenChange={(next, details) => {
				// Clicks on the real controls leave the guide up; only Escape
				// (or Skip) dismisses it.
				if (!next && details.reason === "escape-key") guide.dismiss();
			}}
		>
			<PopoverPopup
				anchor={anchor}
				side={placement.side}
				align={placement.align}
				sideOffset={10}
				initialFocus={primary}
				data-zot-guide-card=""
				className="w-80"
				onKeyDown={(event) => {
					if (event.key === "ArrowRight") guide.next();
					if (event.key === "ArrowLeft") guide.back();
				}}
			>
				<ZotGuideBody
					step={step}
					hasRepositories={snapshot.master.repositories.length > 0}
					onTryExample={tryExample ? () => tryExample("delegate") : null}
					targetHidden={!anchored}
					primaryRef={primary}
					onSkip={guide.dismiss}
					onBack={guide.back}
					onNext={guide.next}
					onGoTo={guide.goTo}
				/>
			</PopoverPopup>
		</Popover>
	);
}

/** The steps after the welcome card; the welcome card lists them as a plan. */
const TOUR_STEPS = ZOT_ONBOARDING_STEPS.filter(
	(step): step is Exclude<ZotOnboardingStep, "welcome"> => step !== "welcome",
);

/** The card's content; explanation only, its sole effect is the callbacks. */
export function ZotGuideBody({
	step,
	hasRepositories,
	onTryExample,
	targetHidden,
	primaryRef,
	onSkip,
	onBack,
	onNext,
	onGoTo,
}: {
	readonly step: ZotOnboardingStep;
	readonly hasRepositories: boolean;
	/** Present only when the example can go into this Zot's own composer. */
	readonly onTryExample: (() => void) | null;
	readonly targetHidden: boolean;
	readonly primaryRef?: RefObject<HTMLButtonElement | null>;
	readonly onSkip: () => void;
	readonly onBack: () => void;
	readonly onNext: () => void;
	readonly onGoTo: (step: ZotOnboardingStep) => void;
}) {
	const { message } = useMessages("projects");
	const welcome = step === "welcome";
	const position = welcome ? -1 : TOUR_STEPS.indexOf(step);
	const last = position === TOUR_STEPS.length - 1;
	const content: Record<ZotOnboardingStep, ReactNode> = {
		welcome: (
			<>
				<p className="text-foreground/80">
					{message("projects:masters_guide_welcome_body")}
				</p>
				<ol className="-mx-1.5 flex flex-col">
					{TOUR_STEPS.map((item, index) => (
						<li key={item}>
							<button
								type="button"
								onClick={() => onGoTo(item)}
								className="flex w-full items-start gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
							>
								<span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium tabular-nums text-foreground">
									{index + 1}
								</span>
								<span className="flex min-w-0 flex-col">
									<span className="text-foreground">
										{message(`projects:masters_guide_${item}_title`)}
									</span>
									<span className="text-[11px] leading-4">
										{message(`projects:masters_guide_${item}_summary`)}
									</span>
								</span>
							</button>
						</li>
					))}
				</ol>
				<p className="text-[11px] leading-4">
					{message("projects:masters_guide_welcome_preview")}
				</p>
			</>
		),
		repositories: (
			<>
				<p className="text-foreground/80">
					{message("projects:masters_guide_repositories_body")}
				</p>
				<p className="text-[11px] leading-4">
					{hasRepositories
						? message("projects:masters_guide_repositories_optional")
						: message("projects:masters_guide_repositories_empty")}
				</p>
			</>
		),
		brief: (
			<>
				<p className="text-foreground/80">
					{message("projects:masters_guide_brief_body")}
				</p>
				<p className="text-[11px] leading-4">
					{message("projects:masters_guide_brief_model")}
				</p>
				{onTryExample ? (
					<div className="flex items-center gap-2">
						<Button variant="secondary" size="sm" onClick={onTryExample}>
							{message("projects:masters_guide_brief_example")}
						</Button>
						<span className="text-[11px] leading-4">
							{message("projects:masters_guide_brief_example_hint")}
						</span>
					</div>
				) : null}
			</>
		),
		slaves: (
			<>
				<p className="text-foreground/80">
					{message("projects:masters_guide_slaves_body")}
				</p>
				<p className="text-[11px] leading-4">
					{message("projects:masters_guide_slaves_controls")}
				</p>
			</>
		),
		continuity: (
			<>
				<p className="text-foreground/80">
					{message("projects:masters_guide_continuity_body")}
				</p>
				<p className="text-[11px] leading-4">
					{message("projects:masters_guide_continuity_memory")}
				</p>
			</>
		),
	};
	return (
		<div className="flex flex-col gap-2.5 px-1.5 py-1 text-[12px] leading-[18px]">
			<div className="flex items-center gap-2">
				<PopoverTitle className="min-w-0 flex-1 text-[13px] leading-5 font-medium">
					{message(`projects:masters_guide_${step}_title`)}
				</PopoverTitle>
				{welcome ? null : (
					<span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
						{message("projects:masters_guide_step_count", {
							current: position + 1,
							total: TOUR_STEPS.length,
						})}
					</span>
				)}
				<Button
					variant="ghost"
					size="icon-sm"
					className="-mr-1 shrink-0 text-muted-foreground"
					aria-label={message("projects:masters_guide_skip")}
					onClick={onSkip}
				>
					<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
				</Button>
			</div>
			<div className="flex flex-col gap-1.5 text-muted-foreground">
				{content[step]}
				{targetHidden ? (
					<p className="text-[11px] leading-4">
						{message("projects:masters_guide_target_hidden")}
					</p>
				) : null}
			</div>
			<div className="flex items-center gap-1 pt-0.5">
				{welcome ? (
					<Button
						variant="ghost"
						className="text-muted-foreground"
						onClick={onSkip}
					>
						{message("projects:masters_guide_not_now")}
					</Button>
				) : (
					<ol
						className="flex items-center gap-1"
						aria-label={message("projects:masters_guide_step_count", {
							current: position + 1,
							total: TOUR_STEPS.length,
						})}
					>
						{TOUR_STEPS.map((item, index) => (
							<li
								key={item}
								className={cn(
									"h-1 rounded-full transition-[width,background-color]",
									index === position
										? "w-4 bg-primary"
										: index < position
											? "w-1.5 bg-foreground/40"
											: "w-1.5 bg-muted-foreground/25",
								)}
							/>
						))}
					</ol>
				)}
				<span className="flex-1" />
				{welcome ? null : (
					<Button variant="ghost" onClick={onBack}>
						{message("projects:masters_guide_back")}
					</Button>
				)}
				<Button ref={primaryRef} onClick={onNext}>
					{welcome
						? message("projects:masters_guide_start")
						: last
							? message("projects:masters_guide_done")
							: message("projects:masters_guide_next")}
				</Button>
			</div>
		</div>
	);
}
