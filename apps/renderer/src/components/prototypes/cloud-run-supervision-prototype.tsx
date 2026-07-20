/**
 * PROTOTYPE — delete after the cloud-run supervision UX is decided.
 * Three variants of the same desktop/mobile experience, switchable with
 * `/cloud-run-prototype.html?variant=A|B|C` in the renderer dev server.
 */
import {
	AlertTriangle,
	AppWindow,
	ArrowLeft,
	ArrowRight,
	Bot,
	Camera,
	Check,
	CirclePause,
	CirclePlay,
	Clock3,
	Cloud,
	ExternalLink,
	FileText,
	Globe2,
	Hand,
	Keyboard,
	Laptop,
	MessageSquarePlus,
	Monitor,
	MousePointer2,
	PanelRight,
	Play,
	RefreshCw,
	RotateCcw,
	ShieldCheck,
	Smartphone,
	TestTube2,
	UserRound,
	Video,
	WifiOff,
	X,
} from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

type Variant = "A" | "B" | "C";
type Viewport = "desktop" | "mobile";
type Surface = "preview" | "browser";
type Lifecycle =
	| "provisioning"
	| "ready"
	| "recording"
	| "paused"
	| "failed"
	| "expired"
	| "reconnecting";
type Ownership = "agent" | "human";
type EvidenceKind = "screenshots" | "video" | "logs" | "tests";
type CommentAnchor = "page" | "moment";

interface PrototypeState {
	readonly lifecycle: Lifecycle;
	readonly ownership: Ownership;
	readonly surface: Surface;
	readonly evidence: EvidenceKind;
	readonly commentAnchor: CommentAnchor;
	readonly linkExpired: boolean;
	readonly takeoverOpen: boolean;
	readonly comment: string;
	readonly comments: ReadonlyArray<PrototypeComment>;
	readonly setLifecycle: (state: Lifecycle) => void;
	readonly setOwnership: (owner: Ownership) => void;
	readonly setSurface: (surface: Surface) => void;
	readonly setEvidence: (kind: EvidenceKind) => void;
	readonly setCommentAnchor: (anchor: CommentAnchor) => void;
	readonly setLinkExpired: (expired: boolean) => void;
	readonly setTakeoverOpen: (open: boolean) => void;
	readonly setComment: (comment: string) => void;
	readonly submitComment: () => void;
	readonly retryAttempt: () => void;
	readonly resumeRun: () => void;
}

interface PrototypeComment {
	readonly id: number;
	readonly anchor: string;
	readonly text: string;
}

const variants: ReadonlyArray<{
	readonly id: Variant;
	readonly label: string;
	readonly description: string;
}> = [
	{
		id: "A",
		label: "Run cockpit",
		description: "Persistent status, viewer, and review inspector",
	},
	{
		id: "B",
		label: "Focus canvas",
		description: "Viewer first, with controls and evidence in drawers",
	},
	{
		id: "C",
		label: "Evidence timeline",
		description: "Review events lead; the live viewer follows selection",
	},
];

const lifecycleMeta: Record<
	Lifecycle,
	{
		readonly label: string;
		readonly detail: string;
		readonly badge: "info" | "success" | "warning" | "error" | "outline";
	}
> = {
	provisioning: {
		label: "Provisioning",
		detail: "Preparing attempt 2 of this run",
		badge: "info",
	},
	ready: {
		label: "Ready",
		detail: "Preview is available; browser is idle",
		badge: "success",
	},
	recording: {
		label: "Recording",
		detail: "Agent browser and evidence capture are live",
		badge: "success",
	},
	paused: {
		label: "Paused",
		detail: "Machine suspended; last frame remains available",
		badge: "warning",
	},
	failed: {
		label: "Failed",
		detail: "Attempt 1 stopped; evidence and logs were preserved",
		badge: "error",
	},
	expired: {
		label: "Expired",
		detail: "Retention ended; the machine and private routes are gone",
		badge: "outline",
	},
	reconnecting: {
		label: "Reconnecting",
		detail: "Showing the last confirmed frame; input is frozen",
		badge: "warning",
	},
};

const lifecycleOrder: ReadonlyArray<Lifecycle> = [
	"provisioning",
	"ready",
	"recording",
	"paused",
	"failed",
	"expired",
	"reconnecting",
];

export function CloudRunSupervisionPrototype() {
	const [variant, setVariant] = useState<Variant>(() => readVariant());
	const [viewport, setViewport] = useState<Viewport>("desktop");
	const [lifecycle, setLifecycle] = useState<Lifecycle>("recording");
	const [ownership, setOwnership] = useState<Ownership>("agent");
	const [surface, setSurface] = useState<Surface>("preview");
	const [evidence, setEvidence] = useState<EvidenceKind>("screenshots");
	const [commentAnchor, setCommentAnchor] = useState<CommentAnchor>("page");
	const [linkExpired, setLinkExpired] = useState(false);
	const [takeoverOpen, setTakeoverOpen] = useState(false);
	const [comment, setComment] = useState("");
	const [comments, setComments] = useState<ReadonlyArray<PrototypeComment>>([
		{
			id: 1,
			anchor: "Recording 01:42 · checkout",
			text: "The mobile total wraps here. Please verify the narrow layout.",
		},
	]);
	const commentRef = useRef<HTMLTextAreaElement>(null);

	const changeVariant = useCallback((next: Variant) => {
		setVariant(next);
		const url = new URL(window.location.href);
		url.searchParams.set("variant", next);
		window.history.replaceState(null, "", url);
	}, []);

	const cycleVariant = useCallback(
		(direction: -1 | 1) => {
			const index = variants.findIndex((item) => item.id === variant);
			const next = (index + direction + variants.length) % variants.length;
			changeVariant(variants[next]?.id ?? "A");
		},
		[changeVariant, variant],
	);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				target instanceof HTMLSelectElement ||
				(target instanceof HTMLElement && target.isContentEditable)
			) {
				return;
			}
			if (event.key === "ArrowLeft") cycleVariant(-1);
			if (event.key === "ArrowRight") cycleVariant(1);
			if (event.key.toLowerCase() === "p") setSurface("preview");
			if (event.key.toLowerCase() === "b") setSurface("browser");
			if (event.key.toLowerCase() === "c") commentRef.current?.focus();
			if (
				event.key.toLowerCase() === "t" &&
				surface === "browser" &&
				isInteractive(lifecycle)
			) {
				setTakeoverOpen(true);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [cycleVariant, lifecycle, surface]);

	const submitComment = () => {
		const text = comment.trim();
		if (text.length === 0) return;
		const anchor =
			commentAnchor === "page"
				? surface === "preview"
					? "Page · /checkout"
					: "Browser · /admin/orders"
				: "Recording 02:14 · checkout";
		setComments((current) => [...current, { id: Date.now(), anchor, text }]);
		setComment("");
	};

	const retryAttempt = () => {
		setLifecycle("provisioning");
		setOwnership("agent");
		window.setTimeout(() => setLifecycle("ready"), 900);
	};

	const resumeRun = () => {
		setLifecycle("reconnecting");
		window.setTimeout(() => setLifecycle("recording"), 700);
	};

	const prototype: PrototypeState = {
		lifecycle,
		ownership,
		surface,
		evidence,
		commentAnchor,
		linkExpired,
		takeoverOpen,
		comment,
		comments,
		setLifecycle,
		setOwnership,
		setSurface,
		setEvidence,
		setCommentAnchor,
		setLinkExpired,
		setTakeoverOpen,
		setComment,
		submitComment,
		retryAttempt,
		resumeRun,
	};

	const activeVariant =
		variants.find((item) => item.id === variant) ?? variants[0];
	const mobile = viewport === "mobile";

	return (
		<div className="flex h-dvh min-h-0 w-screen flex-col overflow-hidden bg-background text-foreground">
			<PrototypeLabBar state={prototype} />
			<main
				className={cn(
					"mx-auto flex min-h-0 w-full flex-1 overflow-hidden transition-[max-width] duration-200 ease-out",
					mobile &&
						"my-3 max-w-[430px] rounded-[28px] ring-1 ring-border shadow-2xl",
				)}
			>
				{variant === "A" ? (
					<VariantA mobile={mobile} state={prototype} commentRef={commentRef} />
				) : null}
				{variant === "B" ? (
					<VariantB mobile={mobile} state={prototype} commentRef={commentRef} />
				) : null}
				{variant === "C" ? (
					<VariantC mobile={mobile} state={prototype} commentRef={commentRef} />
				) : null}
			</main>
			<PrototypeSwitcher
				current={variant}
				description={activeVariant?.description ?? ""}
				viewport={viewport}
				onChange={changeVariant}
				onCycle={cycleVariant}
				onViewportChange={setViewport}
			/>
			<TakeoverDialog state={prototype} />
		</div>
	);
}

function PrototypeLabBar({ state }: { readonly state: PrototypeState }) {
	return (
		<div className="z-40 flex min-h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-bg-subtle px-3 text-xs">
			<span className="shrink-0 font-medium text-muted-foreground">
				Prototype states
			</span>
			{lifecycleOrder.map((item) => (
				<button
					key={item}
					type="button"
					aria-pressed={state.lifecycle === item}
					className={cn(
						"min-h-8 shrink-0 rounded-md px-2.5 font-medium capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
						state.lifecycle === item
							? "bg-foreground text-background"
							: "text-muted-foreground hover:bg-accent hover:text-foreground",
					)}
					onClick={() => state.setLifecycle(item)}
				>
					{item}
				</button>
			))}
			<span className="h-5 w-px shrink-0 bg-border" />
			<button
				type="button"
				className="min-h-8 shrink-0 rounded-md px-2.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onClick={() => state.setLinkExpired(true)}
			>
				Expire preview link
			</button>
		</div>
	);
}

function VariantA({
	mobile,
	state,
	commentRef,
}: {
	readonly mobile: boolean;
	readonly state: PrototypeState;
	readonly commentRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
	const [mobileSection, setMobileSection] = useState<
		"live" | "evidence" | "activity"
	>("live");
	return (
		<div className="relative flex min-h-0 flex-1 flex-col bg-background">
			<RunHeader state={state} compact={mobile} />
			{mobile ? (
				<>
					<div className="min-h-0 flex-1 overflow-y-auto pb-24">
						{mobileSection === "live" ? <LiveWorkspace state={state} /> : null}
						{mobileSection === "evidence" ? (
							<div className="p-3">
								<EvidencePanel state={state} />
								<div className="mt-3">
									<CommentComposer state={state} commentRef={commentRef} />
								</div>
							</div>
						) : null}
						{mobileSection === "activity" ? (
							<div className="p-3">
								<ActivityPanel state={state} />
							</div>
						) : null}
					</div>
					<MobileNav current={mobileSection} onChange={setMobileSection} />
				</>
			) : (
				<div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(420px,1fr)_320px]">
					<aside className="min-h-0 overflow-y-auto border-r border-border bg-bg-subtle p-3">
						<ActivityPanel state={state} />
					</aside>
					<LiveWorkspace state={state} />
					<aside className="min-h-0 overflow-y-auto border-l border-border bg-bg-subtle p-3">
						<EvidencePanel state={state} />
						<div className="mt-3">
							<CommentComposer state={state} commentRef={commentRef} />
						</div>
					</aside>
				</div>
			)}
		</div>
	);
}

function VariantB({
	mobile,
	state,
	commentRef,
}: {
	readonly mobile: boolean;
	readonly state: PrototypeState;
	readonly commentRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
	const [drawer, setDrawer] = useState<"closed" | "evidence" | "comment">(
		mobile ? "closed" : "evidence",
	);
	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-black">
			<div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 bg-gradient-to-b from-black/80 to-transparent p-3 pb-10 text-white">
				<div className="flex min-w-0 items-center gap-2">
					<Cloud className="size-4 shrink-0" />
					<span className="truncate font-medium text-sm">
						Fix mobile checkout
					</span>
					<LifecycleBadge lifecycle={state.lifecycle} />
				</div>
				<div className="flex items-center gap-1.5">
					<Button
						className="border-white/15 bg-black/40 text-white hover:bg-black/60"
						size={mobile ? "icon" : "sm"}
						variant="outline"
						aria-label="Open evidence drawer"
						onClick={() =>
							setDrawer(drawer === "evidence" ? "closed" : "evidence")
						}
					>
						<PanelRight />
						{mobile ? null : "Evidence"}
					</Button>
					<Button
						className="border-white/15 bg-black/40 text-white hover:bg-black/60"
						size={mobile ? "icon" : "sm"}
						variant="outline"
						aria-label="Add anchored comment"
						onClick={() =>
							setDrawer(drawer === "comment" ? "closed" : "comment")
						}
					>
						<MessageSquarePlus />
						{mobile ? null : "Comment"}
					</Button>
				</div>
			</div>
			<div className="min-h-0 flex-1 p-2 pt-1">
				<LiveViewer state={state} immersive />
			</div>
			<div className="absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-black/90 to-transparent p-3 pt-12">
				<SurfaceControl state={state} dark />
			</div>
			{drawer !== "closed" ? (
				<aside
					className={cn(
						"absolute z-30 overflow-y-auto border-border bg-background shadow-2xl",
						mobile
							? "inset-x-0 bottom-0 max-h-[72%] rounded-t-2xl border-t pb-[env(safe-area-inset-bottom)]"
							: "inset-y-0 right-0 w-[360px] border-l",
					)}
				>
					<div className="sticky top-0 z-10 flex min-h-12 items-center justify-between border-b border-border bg-background px-3">
						<p className="font-semibold text-sm">
							{drawer === "evidence" ? "Run evidence" : "Leave feedback"}
						</p>
						<Button
							size="icon"
							variant="ghost"
							aria-label="Close drawer"
							onClick={() => setDrawer("closed")}
						>
							<X />
						</Button>
					</div>
					<div className="p-3">
						{drawer === "evidence" ? <EvidencePanel state={state} /> : null}
						{drawer === "comment" ? (
							<CommentComposer state={state} commentRef={commentRef} />
						) : null}
					</div>
				</aside>
			) : null}
		</div>
	);
}

function VariantC({
	mobile,
	state,
	commentRef,
}: {
	readonly mobile: boolean;
	readonly state: PrototypeState;
	readonly commentRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
	const [mobileDetail, setMobileDetail] = useState(false);
	return (
		<div className="flex min-h-0 flex-1 flex-col bg-bg-subtle">
			<RunHeader state={state} compact={mobile} />
			<div
				className={cn(
					"min-h-0 flex-1",
					mobile ? "relative" : "grid grid-cols-[minmax(320px,0.72fr)_1.28fr]",
				)}
			>
				<section
					className={cn(
						"min-h-0 overflow-y-auto bg-background",
						!mobile && "border-r border-border",
						mobile && mobileDetail && "hidden",
					)}
				>
					<div className="sticky top-0 z-10 border-b border-border bg-background/95 p-3 backdrop-blur">
						<h2 className="font-semibold">Run timeline</h2>
						<p className="mt-1 text-muted-foreground text-xs">
							Live actions, evidence, comments, and attempt changes in one
							record.
						</p>
					</div>
					<Timeline state={state} onOpen={() => setMobileDetail(true)} />
				</section>
				<section
					className={cn(
						"min-h-0 flex-col overflow-hidden",
						mobile && !mobileDetail ? "hidden" : "flex",
					)}
				>
					{mobile ? (
						<button
							type="button"
							className="flex min-h-11 items-center gap-2 border-b border-border bg-background px-3 text-sm"
							onClick={() => setMobileDetail(false)}
						>
							<ArrowLeft className="size-4" />
							Back to timeline
						</button>
					) : null}
					<div className="min-h-0 flex-1">
						<LiveWorkspace state={state} />
					</div>
					<div className="max-h-[42%] overflow-y-auto border-t border-border bg-background p-3">
						<div className={cn("grid gap-3", !mobile && "grid-cols-2")}>
							<EvidencePanel state={state} />
							<CommentComposer state={state} commentRef={commentRef} />
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}

function RunHeader({
	state,
	compact,
}: {
	readonly state: PrototypeState;
	readonly compact: boolean;
}) {
	const meta = lifecycleMeta[state.lifecycle];
	return (
		<header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3">
			<div className="flex min-w-0 items-center gap-2.5">
				<div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
					<Cloud className="size-4" />
				</div>
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<h1 className="truncate font-semibold text-sm">
							Fix mobile checkout
						</h1>
						<LifecycleBadge lifecycle={state.lifecycle} />
					</div>
					<p className="truncate text-muted-foreground text-xs">
						{meta.detail}
					</p>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{!compact ? (
					<div className="text-right text-xs">
						<p className="font-medium">Run CR-1842</p>
						<p className="text-muted-foreground">Attempt 2 · 18m 42s</p>
					</div>
				) : null}
				{state.lifecycle === "paused" ? (
					<Button size="sm" onClick={state.resumeRun}>
						<Play /> Resume
					</Button>
				) : null}
			</div>
		</header>
	);
}

function LifecycleBadge({ lifecycle }: { readonly lifecycle: Lifecycle }) {
	const meta = lifecycleMeta[lifecycle];
	return (
		<Badge className="capitalize" size="sm" variant={meta.badge}>
			{lifecycle === "recording" ? (
				<span className="size-1.5 rounded-full bg-current" />
			) : null}
			{meta.label}
		</Badge>
	);
}

function LiveWorkspace({ state }: { readonly state: PrototypeState }) {
	return (
		<section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
			<div className="flex min-h-12 items-center justify-between gap-2 border-b border-border px-3">
				<SurfaceTabs state={state} />
				<OwnershipControl state={state} />
			</div>
			<div className="min-h-[320px] flex-1 p-3">
				<LiveViewer state={state} />
			</div>
			<PermissionLegend state={state} />
		</section>
	);
}

function SurfaceTabs({ state }: { readonly state: PrototypeState }) {
	return (
		<div className="flex items-center rounded-lg bg-muted p-0.5">
			<button
				type="button"
				aria-pressed={state.surface === "preview"}
				className={cn(
					"flex min-h-9 items-center gap-1.5 rounded-md px-3 font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
					state.surface === "preview"
						? "bg-background text-foreground shadow-xs"
						: "text-muted-foreground",
				)}
				onClick={() => state.setSurface("preview")}
			>
				<AppWindow className="size-4" /> Preview
			</button>
			<button
				type="button"
				aria-pressed={state.surface === "browser"}
				className={cn(
					"flex min-h-9 items-center gap-1.5 rounded-md px-3 font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
					state.surface === "browser"
						? "bg-background text-foreground shadow-xs"
						: "text-muted-foreground",
				)}
				onClick={() => state.setSurface("browser")}
			>
				<Globe2 className="size-4" /> Agent browser
			</button>
		</div>
	);
}

function SurfaceControl({
	state,
	dark = false,
}: {
	readonly state: PrototypeState;
	readonly dark?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex max-w-full items-center gap-1 rounded-xl p-1 shadow-lg",
				dark ? "bg-black/70 text-white backdrop-blur" : "bg-background",
			)}
		>
			<Button
				className={cn(dark && "text-white hover:bg-white/10")}
				size="sm"
				variant={state.surface === "preview" ? "secondary" : "ghost"}
				onClick={() => state.setSurface("preview")}
			>
				<AppWindow /> Preview
			</Button>
			<Button
				className={cn(dark && "text-white hover:bg-white/10")}
				size="sm"
				variant={state.surface === "browser" ? "secondary" : "ghost"}
				onClick={() => state.setSurface("browser")}
			>
				<Globe2 /> Browser
			</Button>
			{state.surface === "browser" ? (
				<OwnershipControl state={state} compact />
			) : (
				<Badge className="ml-1" variant="outline">
					<ShieldCheck /> View only
				</Badge>
			)}
		</div>
	);
}

function OwnershipControl({
	state,
	compact = false,
}: {
	readonly state: PrototypeState;
	readonly compact?: boolean;
}) {
	if (state.surface !== "browser") {
		return (
			<Badge variant="outline">
				<ShieldCheck /> Preview only
			</Badge>
		);
	}
	if (state.ownership === "human") {
		return (
			<Button
				size="sm"
				variant="outline"
				disabled={!isInteractive(state.lifecycle)}
				onClick={() => state.setOwnership("agent")}
			>
				<Bot /> {compact ? "Return" : "Return control to agent"}
			</Button>
		);
	}
	return (
		<Button
			size="sm"
			disabled={!isInteractive(state.lifecycle)}
			onClick={() => state.setTakeoverOpen(true)}
		>
			<Hand /> {compact ? "Take control" : "Take browser control"}
		</Button>
	);
}

function LiveViewer({
	state,
	immersive = false,
}: {
	readonly state: PrototypeState;
	readonly immersive?: boolean;
}) {
	const blocked = !isInteractive(state.lifecycle);
	return (
		<div
			className={cn(
				"relative isolate flex h-full min-h-[300px] overflow-hidden bg-[#f7f7f4] text-[#1c2018] shadow-[0_0_0_1px_rgba(0,0,0,0.12)]",
				immersive ? "rounded-xl" : "rounded-lg",
				state.surface === "browser" &&
					state.ownership === "human" &&
					"ring-2 ring-primary ring-offset-2 ring-offset-background",
			)}
		>
			<FakeApplication browser={state.surface === "browser"} />
			{state.surface === "browser" &&
			state.ownership === "agent" &&
			!blocked ? (
				<div className="pointer-events-none absolute left-[58%] top-[45%] z-10 flex items-start gap-1 text-[#181b14]">
					<MousePointer2 className="size-5 fill-primary stroke-[#181b14]" />
					<span className="rounded bg-[#181b14] px-1.5 py-0.5 font-medium text-[10px] text-white shadow">
						Agent
					</span>
				</div>
			) : null}
			{state.surface === "browser" &&
			state.ownership === "human" &&
			!blocked ? (
				<div className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-md bg-[#181b14] px-2 py-1 font-medium text-white text-xs shadow">
					<UserRound className="size-3.5" /> You have control
				</div>
			) : null}
			{state.linkExpired && state.surface === "preview" ? (
				<ViewerOverlay
					icon={<ShieldCheck className="size-5" />}
					title="Private preview link expired"
					detail="The run is still active. Create a new authenticated link without changing browser control."
					action={
						<Button size="sm" onClick={() => state.setLinkExpired(false)}>
							<RefreshCw /> Create new link
						</Button>
					}
				/>
			) : null}
			{!state.linkExpired && state.lifecycle === "provisioning" ? (
				<div className="absolute inset-0 z-20 grid place-items-center bg-background p-6 text-foreground">
					<div className="w-full max-w-sm space-y-4">
						<div className="space-y-2 text-center">
							<Cloud className="mx-auto size-6 text-muted-foreground" />
							<p className="font-semibold">Preparing a fresh attempt</p>
							<p className="text-muted-foreground text-sm">
								Reusing the run history while a new isolated machine starts.
							</p>
						</div>
						<Skeleton className="h-2 w-full rounded-full" />
						<div className="grid grid-cols-3 gap-2">
							<Skeleton className="h-14" />
							<Skeleton className="h-14" />
							<Skeleton className="h-14" />
						</div>
					</div>
				</div>
			) : null}
			{!state.linkExpired && state.lifecycle === "paused" ? (
				<ViewerOverlay
					icon={<CirclePause className="size-5" />}
					title="Run paused"
					detail="This is the last confirmed frame from 2 minutes ago. Resume restores the same run."
					action={
						<Button size="sm" onClick={state.resumeRun}>
							<Play /> Resume run
						</Button>
					}
					transparent
				/>
			) : null}
			{!state.linkExpired && state.lifecycle === "reconnecting" ? (
				<ViewerOverlay
					icon={<WifiOff className="size-5" />}
					title="Reconnecting to this run"
					detail="Input is frozen until ownership and lifecycle version are confirmed."
					action={
						<Button
							size="sm"
							variant="outline"
							onClick={() => state.setLifecycle("recording")}
						>
							<RefreshCw /> Retry now
						</Button>
					}
					transparent
				/>
			) : null}
			{!state.linkExpired && state.lifecycle === "failed" ? (
				<ViewerOverlay
					icon={<AlertTriangle className="size-5 text-destructive" />}
					title="Attempt failed"
					detail="The run, transcript, and captured evidence are safe. Replace only the machine attempt."
					action={
						<Button size="sm" onClick={state.retryAttempt}>
							<RotateCcw /> Start replacement attempt
						</Button>
					}
				/>
			) : null}
			{!state.linkExpired && state.lifecycle === "expired" ? (
				<ViewerOverlay
					icon={<Clock3 className="size-5" />}
					title="Run resources expired"
					detail="The machine and private routes were deleted. Evidence remains until Aug 15."
					action={
						<Button size="sm" variant="outline" onClick={state.retryAttempt}>
							<Cloud /> Start a new attempt
						</Button>
					}
				/>
			) : null}
		</div>
	);
}

function FakeApplication({ browser }: { readonly browser: boolean }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col text-xs">
			{browser ? (
				<div className="flex h-10 shrink-0 items-center gap-2 border-[#d8dbd2] border-b bg-[#eceee8] px-2">
					<div className="flex gap-1">
						<span className="size-2.5 rounded-full bg-[#ff7a66]" />
						<span className="size-2.5 rounded-full bg-[#f2c94c]" />
						<span className="size-2.5 rounded-full bg-[#6fcf97]" />
					</div>
					<div className="flex min-w-0 flex-1 items-center gap-1.5 rounded bg-white px-2 py-1 text-[#68705f] shadow-sm">
						<ShieldCheck className="size-3" />
						<span className="truncate">private.run.local/admin/orders</span>
					</div>
				</div>
			) : null}
			<div className="flex min-h-0 flex-1">
				<aside className="hidden w-36 shrink-0 border-[#e1e3dc] border-r bg-white p-3 sm:block">
					<div className="mb-5 flex items-center gap-2 font-bold">
						<span className="grid size-6 place-items-center rounded bg-[#d7ff3f]">
							Z
						</span>
						Northstar
					</div>
					{["Overview", "Orders", "Customers", "Products"].map(
						(item, index) => (
							<div
								key={item}
								className={cn(
									"mb-1 rounded px-2 py-1.5",
									index === 1 ? "bg-[#edf4d5] font-medium" : "text-[#6b7164]",
								)}
							>
								{item}
							</div>
						),
					)}
				</aside>
				<div className="min-w-0 flex-1 overflow-hidden p-4 sm:p-6">
					<div className="mb-5 flex items-start justify-between gap-3">
						<div>
							<p className="text-[#747b6d]">Order #8419</p>
							<h3 className="mt-1 font-bold text-lg">Checkout review</h3>
						</div>
						<span className="rounded-full bg-[#e0f5e5] px-2 py-1 font-medium text-[#23753b]">
							Paid
						</span>
					</div>
					<div className="grid gap-3 sm:grid-cols-[1.3fr_0.7fr]">
						<div className="rounded-lg bg-white p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.08)]">
							<p className="mb-3 font-semibold">Items</p>
							{["Field jacket", "Canvas tote"].map((item, index) => (
								<div
									key={item}
									className="flex items-center gap-3 border-[#eceee8] border-b py-3 last:border-0"
								>
									<div className="size-9 rounded bg-[#eef0e9]" />
									<div className="min-w-0 flex-1">
										<p className="font-medium">{item}</p>
										<p className="text-[#747b6d]">Qty 1</p>
									</div>
									<p className="font-mono tabular-nums">
										${index === 0 ? "124" : "38"}.00
									</p>
								</div>
							))}
						</div>
						<div className="rounded-lg bg-[#20251d] p-4 text-white">
							<p className="text-white/60">Total</p>
							<p className="mt-1 font-semibold text-2xl tabular-nums">
								$174.96
							</p>
							<button
								type="button"
								className="mt-6 min-h-10 w-full rounded bg-[#d7ff3f] font-semibold text-[#20251d]"
							>
								Refund order
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function ViewerOverlay({
	icon,
	title,
	detail,
	action,
	transparent = false,
}: {
	readonly icon: ReactNode;
	readonly title: string;
	readonly detail: string;
	readonly action: ReactNode;
	readonly transparent?: boolean;
}) {
	return (
		<div
			className={cn(
				"absolute inset-0 z-20 grid place-items-center p-5 text-foreground",
				transparent ? "bg-background/82 backdrop-blur-sm" : "bg-background",
			)}
		>
			<div className="max-w-sm text-center">
				<div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-muted">
					{icon}
				</div>
				<p className="font-semibold">{title}</p>
				<p className="mt-1 text-muted-foreground text-sm">{detail}</p>
				<div className="mt-4 flex justify-center">{action}</div>
			</div>
		</div>
	);
}

function PermissionLegend({ state }: { readonly state: PrototypeState }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-bg-subtle px-3 py-2 text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<span className="flex items-center gap-1 text-muted-foreground">
					<AppWindow className="size-3.5" /> Preview
				</span>
				<Badge variant="outline">View only</Badge>
				<span className="text-border">•</span>
				<span className="flex items-center gap-1 text-muted-foreground">
					<Globe2 className="size-3.5" /> Browser
				</span>
				<Badge variant={state.ownership === "human" ? "warning" : "info"}>
					{state.ownership === "human" ? "You control" : "Agent controls"}
				</Badge>
			</div>
			<span className="flex items-center gap-1 text-muted-foreground">
				<Keyboard className="size-3.5" /> P preview · B browser · T takeover · C
				comment
			</span>
		</div>
	);
}

function ActivityPanel({ state }: { readonly state: PrototypeState }) {
	return (
		<div>
			<SectionHeading title="Run activity" subtitle="Stable across attempts" />
			<div className="mt-3 space-y-1">
				<ActivityItem
					icon={<Check />}
					title="Workspace restored"
					detail="Attempt 2 · 18m ago"
					tone="success"
				/>
				<ActivityItem
					icon={<Bot />}
					title="Agent opened checkout"
					detail="private preview · 4m ago"
				/>
				<ActivityItem
					icon={<Video />}
					title="Recording started"
					detail="02:14 captured"
					tone={state.lifecycle === "recording" ? "danger" : "default"}
				/>
				<ActivityItem
					icon={<MessageSquarePlus />}
					title="Comment added"
					detail="Recording 01:42"
				/>
			</div>
			<div className="mt-4 rounded-lg bg-alert-info-bg p-3 text-info-foreground text-xs ring-1 ring-info/10">
				<p className="font-semibold">Attempt changed, run did not</p>
				<p className="mt-1 opacity-80">
					History, comments, and evidence remain attached to Run CR-1842.
				</p>
			</div>
		</div>
	);
}

function ActivityItem({
	icon,
	title,
	detail,
	tone = "default",
}: {
	readonly icon: ReactNode;
	readonly title: string;
	readonly detail: string;
	readonly tone?: "default" | "success" | "danger";
}) {
	return (
		<div className="flex gap-2 rounded-lg p-2 hover:bg-accent">
			<div
				className={cn(
					"mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-muted [&_svg]:size-3.5",
					tone === "success" && "bg-alert-success-bg text-success-foreground",
					tone === "danger" && "bg-alert-error-bg text-destructive-foreground",
				)}
			>
				{icon}
			</div>
			<div className="min-w-0">
				<p className="font-medium text-xs">{title}</p>
				<p className="text-muted-foreground text-[11px]">{detail}</p>
			</div>
		</div>
	);
}

function EvidencePanel({ state }: { readonly state: PrototypeState }) {
	const tabs: ReadonlyArray<{
		readonly id: EvidenceKind;
		readonly label: string;
		readonly icon: ReactNode;
	}> = [
		{ id: "screenshots", label: "Shots", icon: <Camera /> },
		{ id: "video", label: "Video", icon: <Video /> },
		{ id: "logs", label: "Logs", icon: <FileText /> },
		{ id: "tests", label: "Tests", icon: <TestTube2 /> },
	];
	return (
		<div>
			<SectionHeading
				title="Evidence"
				subtitle="Reviewable after the machine ends"
			/>
			<div className="mt-3 grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						type="button"
						aria-label={tab.label}
						aria-pressed={state.evidence === tab.id}
						className={cn(
							"flex min-h-10 flex-col items-center justify-center gap-0.5 rounded-md text-[10px] outline-none [&_svg]:size-3.5 focus-visible:ring-2 focus-visible:ring-ring",
							state.evidence === tab.id
								? "bg-background text-foreground shadow-xs"
								: "text-muted-foreground",
						)}
						onClick={() => state.setEvidence(tab.id)}
					>
						{tab.icon}
						{tab.label}
					</button>
				))}
			</div>
			<div className="mt-3 min-h-36 rounded-lg bg-background p-3 ring-1 ring-border/70">
				<EvidenceContent kind={state.evidence} />
			</div>
		</div>
	);
}

function EvidenceContent({ kind }: { readonly kind: EvidenceKind }) {
	if (kind === "screenshots") {
		return (
			<div className="grid grid-cols-2 gap-2">
				{["Checkout", "Order detail", "Mobile 390px", "Success"].map(
					(item, index) => (
						<button
							key={item}
							type="button"
							className="text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<div
								className={cn(
									"aspect-video rounded bg-bg-elevated",
									index === 2 && "ring-2 ring-primary",
								)}
							/>
							<p className="mt-1 truncate text-[11px]">{item}</p>
						</button>
					),
				)}
			</div>
		);
	}
	if (kind === "video") {
		return (
			<div>
				<div className="grid aspect-video place-items-center rounded bg-[#181b14] text-white">
					<button
						type="button"
						aria-label="Play recording"
						className="grid size-11 place-items-center rounded-full bg-white/15"
					>
						<CirclePlay className="size-6" />
					</button>
				</div>
				<div className="mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums">
					<span>02:14</span>
					<span className="text-muted-foreground">08:42</span>
				</div>
			</div>
		);
	}
	if (kind === "logs") {
		return (
			<pre className="overflow-x-auto font-mono text-[11px] leading-5 text-muted-foreground">
				<span className="text-success">✓</span> server ready :3000{"\n"}
				GET /checkout 200 42ms{"\n"}
				POST /api/order 201 118ms{"\n"}
				<span className="text-warning">!</span> layout shift 0.04
			</pre>
		);
	}
	return (
		<div className="space-y-2 text-xs">
			<TestRow label="Unit" count="184 passed" passed />
			<TestRow label="Browser" count="12 passed" passed />
			<TestRow label="Visual" count="1 changed" />
			<Button className="mt-1 w-full" size="sm" variant="outline">
				Review changed snapshot <ExternalLink />
			</Button>
		</div>
	);
}

function TestRow({
	label,
	count,
	passed = false,
}: {
	readonly label: string;
	readonly count: string;
	readonly passed?: boolean;
}) {
	return (
		<div className="flex items-center justify-between rounded bg-bg-subtle px-2 py-1.5">
			<span>{label}</span>
			<span className={passed ? "text-success" : "text-warning"}>{count}</span>
		</div>
	);
}

function CommentComposer({
	state,
	commentRef,
}: {
	readonly state: PrototypeState;
	readonly commentRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		state.submitComment();
	};
	return (
		<div>
			<SectionHeading
				title="Comment"
				subtitle="Anchored to what you are reviewing"
			/>
			<form className="mt-3" onSubmit={onSubmit}>
				<div className="mb-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
					<AnchorButton
						active={state.commentAnchor === "page"}
						icon={<Globe2 />}
						label="Current page"
						onClick={() => state.setCommentAnchor("page")}
					/>
					<AnchorButton
						active={state.commentAnchor === "moment"}
						icon={<Clock3 />}
						label="02:14 moment"
						onClick={() => state.setCommentAnchor("moment")}
					/>
				</div>
				<label htmlFor="cloud-run-comment" className="sr-only">
					Comment on the selected page or recording moment
				</label>
				<Textarea
					ref={commentRef}
					id="cloud-run-comment"
					value={state.comment}
					placeholder="What should change here?"
					spellCheck={false}
					onChange={(event) => state.setComment(event.target.value)}
					onKeyDown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
							event.preventDefault();
							state.submitComment();
						}
					}}
				/>
				<div className="mt-2 flex items-center justify-between gap-2">
					<span className="text-muted-foreground text-[11px]">
						⌘↵ to comment
					</span>
					<Button
						size="sm"
						type="submit"
						disabled={state.comment.trim().length === 0}
					>
						<MessageSquarePlus /> Add comment
					</Button>
				</div>
			</form>
			{state.comments.length > 0 ? (
				<div className="mt-3 space-y-2">
					{state.comments.slice(-2).map((item) => (
						<div
							key={item.id}
							className="rounded-lg bg-background p-2.5 text-xs ring-1 ring-border/70"
						>
							<p className="font-medium text-[11px] text-muted-foreground">
								{item.anchor}
							</p>
							<p className="mt-1 leading-5">{item.text}</p>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

function AnchorButton({
	active,
	icon,
	label,
	onClick,
}: {
	readonly active: boolean;
	readonly icon: ReactNode;
	readonly label: string;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			className={cn(
				"flex min-h-9 items-center justify-center gap-1 rounded-md px-2 text-xs outline-none [&_svg]:size-3.5 focus-visible:ring-2 focus-visible:ring-ring",
				active
					? "bg-background font-medium shadow-xs"
					: "text-muted-foreground",
			)}
			onClick={onClick}
		>
			{icon} {label}
		</button>
	);
}

function SectionHeading({
	title,
	subtitle,
}: {
	readonly title: string;
	readonly subtitle: string;
}) {
	return (
		<div>
			<h2 className="font-semibold text-sm">{title}</h2>
			<p className="mt-0.5 text-muted-foreground text-xs">{subtitle}</p>
		</div>
	);
}

function Timeline({
	state,
	onOpen,
}: {
	readonly state: PrototypeState;
	readonly onOpen: () => void;
}) {
	const events = [
		{
			time: "Now",
			title: lifecycleMeta[state.lifecycle].label,
			detail: lifecycleMeta[state.lifecycle].detail,
			icon: <Cloud />,
		},
		{
			time: "02:14",
			title: "Checkout recording",
			detail: "Agent opened the order summary",
			icon: <Video />,
		},
		{
			time: "01:42",
			title: "Feedback on mobile total",
			detail: "Comment attached to the recording",
			icon: <MessageSquarePlus />,
		},
		{
			time: "00:58",
			title: "Visual test changed",
			detail: "1 snapshot needs review",
			icon: <TestTube2 />,
		},
		{
			time: "00:00",
			title: "Attempt 2 ready",
			detail: "Run history carried forward",
			icon: <Check />,
		},
	];
	return (
		<ol className="p-3">
			{events.map((event, index) => (
				<li
					key={`${event.time}-${event.title}`}
					className="relative flex gap-3 pb-5 last:pb-0"
				>
					{index < events.length - 1 ? (
						<span className="absolute left-[17px] top-9 h-[calc(100%-24px)] w-px bg-border" />
					) : null}
					<div className="z-[1] grid size-9 shrink-0 place-items-center rounded-full bg-muted [&_svg]:size-4">
						{event.icon}
					</div>
					<button
						type="button"
						className="min-h-14 min-w-0 flex-1 rounded-lg bg-bg-subtle p-3 text-left outline-none ring-1 ring-border/50 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
						onClick={onOpen}
					>
						<div className="flex items-center justify-between gap-2">
							<p className="font-medium text-sm">{event.title}</p>
							<span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
								{event.time}
							</span>
						</div>
						<p className="mt-1 text-muted-foreground text-xs">{event.detail}</p>
					</button>
				</li>
			))}
		</ol>
	);
}

function MobileNav({
	current,
	onChange,
}: {
	readonly current: "live" | "evidence" | "activity";
	readonly onChange: (value: "live" | "evidence" | "activity") => void;
}) {
	const items = [
		{ id: "live" as const, label: "Live", icon: <Monitor /> },
		{ id: "evidence" as const, label: "Evidence", icon: <Camera /> },
		{ id: "activity" as const, label: "Activity", icon: <Clock3 /> },
	];
	return (
		<nav className="absolute inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-border bg-background/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur">
			{items.map((item) => (
				<button
					key={item.id}
					type="button"
					aria-current={current === item.id ? "page" : undefined}
					className={cn(
						"flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] outline-none [&_svg]:size-4 focus-visible:ring-2 focus-visible:ring-ring",
						current === item.id ? "text-foreground" : "text-muted-foreground",
					)}
					onClick={() => onChange(item.id)}
				>
					{item.icon} {item.label}
				</button>
			))}
		</nav>
	);
}

function TakeoverDialog({ state }: { readonly state: PrototypeState }) {
	return (
		<Dialog open={state.takeoverOpen} onOpenChange={state.setTakeoverOpen}>
			<DialogPopup className="max-w-md" showCloseButton={false}>
				<DialogHeader>
					<div className="mb-1 grid size-10 place-items-center rounded-full bg-alert-warning-bg text-warning-foreground">
						<Hand className="size-5" />
					</div>
					<DialogTitle>Take browser control?</DialogTitle>
					<DialogDescription>
						The agent will finish its current input, then pause. This grants
						keyboard, pointer, and clipboard access to the browser only—not the
						application preview.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="space-y-2 text-sm">
					<PermissionRow
						icon={<MousePointer2 />}
						label="Pointer and keyboard"
						value="Allowed while you control"
					/>
					<PermissionRow
						icon={<AppWindow />}
						label="Application preview"
						value="Stays view-only"
					/>
					<PermissionRow
						icon={<Video />}
						label="Recording"
						value="Continues with a control marker"
					/>
					<div className="mt-3 rounded-lg bg-alert-info-bg p-3 text-info-foreground text-xs ring-1 ring-info/10">
						If the connection drops, input freezes. Control resumes only after
						the server confirms that your lease is still current.
					</div>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
					<Button
						onClick={() => {
							state.setOwnership("human");
							state.setTakeoverOpen(false);
						}}
					>
						<Hand /> Take control
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function PermissionRow({
	icon,
	label,
	value,
}: {
	readonly icon: ReactNode;
	readonly label: string;
	readonly value: string;
}) {
	return (
		<div className="flex items-center gap-2 rounded-lg bg-bg-subtle p-2.5">
			<span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
			<span className="min-w-0 flex-1 font-medium">{label}</span>
			<span className="text-right text-muted-foreground text-xs">{value}</span>
		</div>
	);
}

function PrototypeSwitcher({
	current,
	description,
	viewport,
	onChange,
	onCycle,
	onViewportChange,
}: {
	readonly current: Variant;
	readonly description: string;
	readonly viewport: Viewport;
	readonly onChange: (variant: Variant) => void;
	readonly onCycle: (direction: -1 | 1) => void;
	readonly onViewportChange: (viewport: Viewport) => void;
}) {
	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex justify-center px-3">
			<div className="pointer-events-auto flex max-w-full items-center gap-1 rounded-2xl bg-[#171914] p-1.5 text-white shadow-2xl ring-1 ring-white/10">
				<button
					type="button"
					aria-label="Previous prototype variant"
					className="grid size-11 place-items-center rounded-xl outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white"
					onClick={() => onCycle(-1)}
				>
					<ArrowLeft className="size-4" />
				</button>
				<div className="hidden min-w-44 px-2 sm:block">
					<p className="font-semibold text-xs">
						{current} — {variants.find((item) => item.id === current)?.label}
					</p>
					<p className="mt-0.5 max-w-56 truncate text-[10px] text-white/55">
						{description}
					</p>
				</div>
				<div className="flex rounded-lg bg-white/8 p-0.5">
					{variants.map((variant) => (
						<button
							key={variant.id}
							type="button"
							aria-label={`Show ${variant.label}`}
							aria-pressed={current === variant.id}
							className={cn(
								"size-9 rounded-md font-semibold text-xs outline-none focus-visible:ring-2 focus-visible:ring-white",
								current === variant.id
									? "bg-white text-black"
									: "text-white/65 hover:text-white",
							)}
							onClick={() => onChange(variant.id)}
						>
							{variant.id}
						</button>
					))}
				</div>
				<div className="ml-1 flex rounded-lg bg-white/8 p-0.5">
					<button
						type="button"
						aria-label="Preview desktop layout"
						aria-pressed={viewport === "desktop"}
						className={cn(
							"grid size-9 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-white",
							viewport === "desktop"
								? "bg-white text-black"
								: "text-white/65 hover:text-white",
						)}
						onClick={() => onViewportChange("desktop")}
					>
						<Laptop className="size-4" />
					</button>
					<button
						type="button"
						aria-label="Preview mobile layout"
						aria-pressed={viewport === "mobile"}
						className={cn(
							"grid size-9 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-white",
							viewport === "mobile"
								? "bg-white text-black"
								: "text-white/65 hover:text-white",
						)}
						onClick={() => onViewportChange("mobile")}
					>
						<Smartphone className="size-4" />
					</button>
				</div>
				<button
					type="button"
					aria-label="Next prototype variant"
					className="grid size-11 place-items-center rounded-xl outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white"
					onClick={() => onCycle(1)}
				>
					<ArrowRight className="size-4" />
				</button>
			</div>
		</div>
	);
}

function readVariant(): Variant {
	const value = new URLSearchParams(window.location.search).get("variant");
	return value === "B" || value === "C" ? value : "A";
}

function isInteractive(lifecycle: Lifecycle): boolean {
	return lifecycle === "ready" || lifecycle === "recording";
}
