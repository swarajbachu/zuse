import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	MASTER_MASCOT_COLORS,
	MASTER_MASCOTS,
	MASTER_SETTINGS_LIMITS,
	type MasterAction,
	type MasterArtifact,
	type MasterAvatar,
	type MasterSnapshot,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import {
	PanelRightCloseIcon,
	PencilEdit02Icon,
} from "@zuse/icons/solid-rounded";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { formatError } from "../../lib/format-error.ts";
import { activeSlaveCount } from "../../lib/master-activity.ts";
import { masterCapabilities } from "../../lib/master-capabilities.ts";
import {
	environmentLabel,
	useEnvironmentCatalogStore,
	withConnectedEnvironments,
} from "../../store/environment-catalog.ts";
import {
	DETAILS_WIDTH,
	executeMaster,
	type MasterSelection,
	useMastersStore,
} from "../../store/masters.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
import {
	avatarFor,
	MASCOT_PALETTE,
	Mascot,
	type MascotState,
} from "./mascot.tsx";
import { MasterMemoryPanel } from "./memory.tsx";
import { RepositoryChips } from "./repositories.tsx";
import { PinnedArtifacts, SlaveList } from "./slaves.tsx";

type DetailView = "slaves" | "memory" | "pinned";

/**
 * Right-hand panel: identity, repositories (saved instantly), and rows that
 * push a sub-view in from the right. Preferences open as a page instead.
 */
export function MasterDetails({
	snapshot,
	selection,
	mascotState,
	busy,
	execute,
	perform,
	openChat,
	openArtifact,
	openPreferences,
	onClose,
}: {
	readonly snapshot: MasterSnapshot;
	readonly selection: MasterSelection;
	readonly mascotState: MascotState;
	readonly busy: boolean;
	readonly execute: (action: MasterAction) => Promise<void>;
	readonly perform: (action: MasterAction) => void;
	readonly openChat: (
		environmentId: string,
		chatId: string,
		sessionId: string,
	) => void;
	readonly openArtifact: (artifact: MasterArtifact) => void;
	readonly openPreferences: () => void;
	readonly onClose: () => void;
}) {
	const { message } = useMessages("projects");
	const master = snapshot.master;
	const avatar = avatarFor(master);
	const capabilities = masterCapabilities(snapshot);
	const width = useMastersStore((state) => state.detailsWidth);
	const [view, setView] = useState<DetailView | null>(null);
	// Keep the last sub-view mounted while it slides back out.
	const shown = useRef<DetailView | null>(null);
	if (view) shown.current = view;
	const [editingIdentity, setEditingIdentity] = useState(false);

	const pinned = master.artifacts.filter((artifact) => artifact.pinned);
	const topics =
		master.memory?.topics.filter((topic) => !topic.archived).length ?? 0;
	const rows: ReadonlyArray<{
		key: DetailView | "preferences";
		title: string;
		count?: number;
	}> = [
		{
			key: "slaves",
			title: message("projects:masters_slaves"),
			count: activeSlaveCount(master),
		},
		{ key: "memory", title: message("projects:masters_memory"), count: topics },
		...(pinned.length
			? [
					{
						key: "pinned" as const,
						title: message("projects:masters_pinned"),
						count: pinned.length,
					},
				]
			: []),
		{ key: "preferences", title: message("projects:masters_preferences") },
	];
	const titles: Record<DetailView, string> = {
		slaves: message("projects:masters_slaves"),
		memory: message("projects:masters_memory"),
		pinned: message("projects:masters_pinned"),
	};
	const body = (current: DetailView): ReactNode =>
		current === "slaves" ? (
			<SlaveList
				snapshot={snapshot}
				busy={busy}
				perform={perform}
				openChat={openChat}
			/>
		) : current === "memory" ? (
			<MasterMemoryPanel
				key={master.id}
				master={master}
				selection={selection}
				busy={busy}
				execute={execute}
			/>
		) : (
			<PinnedArtifacts artifacts={pinned} openArtifact={openArtifact} />
		);

	return (
		<aside
			aria-label={message("projects:masters_details")}
			style={{ width }}
			className="relative flex max-w-[55%] shrink-0 flex-col border-l border-border/50"
		>
			<ResizeHandle label={message("projects:masters_resize_details")} />
			<div className="flex h-10 shrink-0 items-center gap-1 pr-1.5 pl-2 text-[12px] font-medium">
				{view ? (
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={message("projects:masters_back")}
						onClick={() => setView(null)}
					>
						<ChevronLeft />
					</Button>
				) : null}
				<span className={cn("min-w-0 flex-1 truncate", !view && "pl-2")}>
					{view ? titles[view] : message("projects:masters_details")}
				</span>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={message("projects:masters_hide_details")}
					onClick={onClose}
				>
					<HugeiconsIcon icon={PanelRightCloseIcon} />
				</Button>
			</div>
			<div className="relative min-h-0 flex-1 overflow-hidden">
				<div
					inert={view !== null}
					className={cn(
						"details-slide absolute inset-0 overflow-y-auto pb-4",
						view && "-translate-x-1/4 opacity-0",
					)}
				>
					{editingIdentity ? (
						<IdentityEditor
							seed={master.id}
							name={master.settings.name}
							avatar={avatar}
							state={mascotState}
							busy={busy}
							onCancel={() => setEditingIdentity(false)}
							onSave={async (next) => {
								await execute({ _tag: "appearance", ...next });
								setEditingIdentity(false);
							}}
						/>
					) : (
						<div className="flex items-center gap-2.5 px-4 pt-1 pb-3">
							<Mascot
								avatar={avatar}
								state={mascotState}
								px={32}
								seed={master.id}
							/>
							<span className="min-w-0 flex-1 truncate text-sm font-medium">
								{master.settings.name}
							</span>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={message("projects:masters_edit_identity")}
								onClick={() => setEditingIdentity(true)}
							>
								<HugeiconsIcon icon={PencilEdit02Icon} />
							</Button>
						</div>
					)}
					<section
						data-zot-guide="repositories"
						className="border-b border-border/50 px-2 pb-3 text-[12px]"
					>
						<h3 className="px-2 pb-1 text-[11px] text-muted-foreground">
							{message("projects:masters_repositories")}
						</h3>
						<RepositoryChips
							home={master.homeEnvironmentId}
							capabilities={capabilities}
							value={master.repositories}
							disabled={busy}
							onChange={(repositories) =>
								perform({ _tag: "repositories", repositories })
							}
						/>
						{capabilities.crossEnvironment ? null : (
							<p className="px-2 pt-1.5 text-[11px] leading-4 text-muted-foreground">
								{message("projects:masters_home_only_note")}
							</p>
						)}
					</section>
					<div className="flex items-center gap-3 border-b border-border/50 px-4 py-2.5 text-[12px]">
						<span className="text-muted-foreground">
							{message("projects:masters_runs_on")}
						</span>
						<div className="min-w-0 flex-1">
							<RunsOn
								selection={selection}
								home={master.homeEnvironmentId}
								canMove={capabilities.homeTransfer}
								busy={busy}
							/>
						</div>
					</div>
					<nav
						aria-label={message("projects:masters_details")}
						className="p-1.5"
					>
						{rows.map((row) => (
							<button
								key={row.key}
								type="button"
								data-zot-guide={row.key === "slaves" ? "slaves" : undefined}
								onClick={() =>
									row.key === "preferences"
										? openPreferences()
										: setView(row.key)
								}
								className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-[12px] outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
							>
								<span className="min-w-0 flex-1 truncate text-foreground">
									{row.title}
								</span>
								{row.count ? (
									<span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
										{row.count}
									</span>
								) : null}
								<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
							</button>
						))}
					</nav>
				</div>
				<div
					inert={view === null}
					className={cn(
						"details-slide absolute inset-0 overflow-y-auto px-3 pb-4",
						!view && "translate-x-full",
					)}
				>
					{shown.current ? body(shown.current) : null}
				</div>
			</div>
		</aside>
	);
}

/** Drag the panel's left edge to resize it; double-click restores the default. */
function ResizeHandle({ label }: { readonly label: string }) {
	const width = useMastersStore((state) => state.detailsWidth);
	const setWidth = useMastersStore((state) => state.setDetailsWidth);
	const drag = useRef<{ x: number; width: number } | null>(null);
	return (
		// biome-ignore lint/a11y/useSemanticElements: a draggable separator, not a rule.
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={width}
			aria-valuemin={DETAILS_WIDTH.min}
			aria-valuemax={DETAILS_WIDTH.max}
			tabIndex={0}
			onDoubleClick={() => setWidth(DETAILS_WIDTH.default)}
			onKeyDown={(event) => {
				const current = useMastersStore.getState().detailsWidth;
				if (event.key === "ArrowLeft") setWidth(current + 16);
				if (event.key === "ArrowRight") setWidth(current - 16);
			}}
			// Pointer capture keeps the drag on this element, so the browser ends
			// it (and our listeners go with the element) on release, cancel or unmount.
			onPointerDown={(event) => {
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = {
					x: event.clientX,
					width: useMastersStore.getState().detailsWidth,
				};
			}}
			onPointerMove={(event) => {
				if (drag.current)
					setWidth(drag.current.width + (drag.current.x - event.clientX));
			}}
			onLostPointerCapture={() => {
				drag.current = null;
			}}
			className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1 after:w-px after:transition-colors hover:after:bg-ring/50 focus-visible:after:bg-ring"
		/>
	);
}

/** One-time edit of name, mascot and colour; nothing changes until Save. */
function IdentityEditor({
	seed,
	name,
	avatar,
	state,
	busy,
	onCancel,
	onSave,
}: {
	readonly seed: string;
	readonly name: string;
	readonly avatar: MasterAvatar;
	readonly state: MascotState;
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onSave: (next: {
		name: string;
		avatar: MasterAvatar;
	}) => Promise<void>;
}) {
	const { message } = useMessages("projects");
	const [value, setValue] = useState(name);
	const [next, setNext] = useState(avatar);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const trimmed = value.trim();
	const changed =
		trimmed !== name ||
		next.mascot !== avatar.mascot ||
		next.color !== avatar.color;
	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			await onSave({ name: trimmed, avatar: next });
		} catch (cause) {
			setError(formatError(cause));
		} finally {
			setSaving(false);
		}
	};
	return (
		<form
			className="details-view-enter flex flex-col items-center gap-3 px-4 pt-2 pb-5"
			onSubmit={(event) => {
				event.preventDefault();
				if (changed && trimmed) void save();
			}}
		>
			<Mascot
				avatar={next}
				state={state}
				size="large"
				px={56}
				seed={seed}
				label={trimmed || name}
			/>
			<Input
				nativeInput
				autoFocus
				aria-label={message("projects:masters_master_name")}
				value={value}
				maxLength={MASTER_SETTINGS_LIMITS.nameLength}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") onCancel();
				}}
				className="h-7 text-center"
			/>
			<fieldset
				aria-label={message("projects:masters_mascot")}
				className="flex gap-1"
			>
				{MASTER_MASCOTS.map((mascot) => {
					const selected = mascot === next.mascot;
					return (
						<button
							key={mascot}
							type="button"
							aria-pressed={selected}
							aria-label={message(`projects:masters_mascot_${mascot}`)}
							onClick={() => setNext({ ...next, mascot })}
							className={cn(
								"grid size-10 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
								selected ? "bg-muted" : "hover:bg-muted/50",
							)}
						>
							<Mascot
								avatar={{ ...next, mascot }}
								state={selected ? state : "idle"}
								px={32}
								seed={`${seed}:${mascot}`}
							/>
						</button>
					);
				})}
			</fieldset>
			<fieldset
				aria-label={message("projects:masters_color")}
				className="flex gap-2"
			>
				{MASTER_MASCOT_COLORS.map((color) => {
					const selected = color === next.color;
					return (
						<button
							key={color}
							type="button"
							aria-pressed={selected}
							aria-label={message(`projects:masters_color_${color}`)}
							onClick={() => setNext({ ...next, color })}
							style={{ backgroundColor: MASCOT_PALETTE[color][0] }}
							className={cn(
								"size-4 rounded-full outline-none ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
								selected && "ring-2 ring-foreground/70",
							)}
						/>
					);
				})}
			</fieldset>
			{error ? (
				<p role="alert" className="text-[11px] text-destructive">
					{error}
				</p>
			) : null}
			<div className="flex w-full justify-end gap-1.5">
				<Button variant="ghost" disabled={saving} onClick={onCancel}>
					{message("projects:masters_cancel")}
				</Button>
				<Button
					type="submit"
					loading={saving}
					disabled={saving || busy || !changed || !trimmed}
				>
					{message("projects:masters_save")}
				</Button>
			</div>
		</form>
	);
}

/** Where the Master's conversation lives; moving it is an explicit action. */
function RunsOn({
	selection,
	home,
	canMove,
	busy,
}: {
	readonly selection: MasterSelection;
	readonly home: string;
	/** Home transfer is only offered where the server supports it. */
	readonly canMove: boolean;
	readonly busy: boolean;
}) {
	const { message } = useMessages("projects");
	const entries = useEnvironmentCatalogStore((state) => state.entries);
	const [target, setTarget] = useState(home);
	const [moving, setMoving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const label = (environmentId: string) =>
		environmentLabel(entries, environmentId) ??
		message("projects:masters_this_environment");
	const options = withConnectedEnvironments(entries, home);
	if (!canMove || options.length < 2)
		return <p className="truncate px-2 pt-1.5">{label(home)}</p>;
	return (
		<div className="flex flex-col gap-1.5">
			<Select
				value={target}
				onValueChange={(value) => {
					if (value !== null) setTarget(value);
				}}
			>
				<SelectTrigger
					className="h-7 w-full border-transparent bg-transparent px-2 shadow-none hover:bg-muted/55"
					aria-label={message("projects:masters_runs_on")}
				>
					<SelectValue>{label(target)}</SelectValue>
				</SelectTrigger>
				<SelectPopup>
					{options.map((option) => (
						<SelectItem key={option} value={option}>
							{label(option)}
						</SelectItem>
					))}
				</SelectPopup>
			</Select>
			{target !== home ? (
				<div className="flex flex-col gap-1 px-2">
					<p className="text-[11px] leading-4 text-muted-foreground">
						{message("projects:masters_move_help")}
					</p>
					{error ? (
						<p role="alert" className="text-[11px] text-destructive">
							{error}
						</p>
					) : null}
					<Button
						size="sm"
						className="self-start"
						loading={moving}
						disabled={busy || moving}
						onClick={() => {
							setMoving(true);
							setError(null);
							void executeMaster(selection, {
								_tag: "move",
								environmentId: target,
							})
								.then((moved) =>
									useMastersStore.getState().select({
										environmentId: moved.homeEnvironmentId,
										masterId: moved.id,
									}),
								)
								.catch((cause) => setError(formatError(cause)))
								.finally(() => setMoving(false));
						}}
					>
						{message("projects:masters_move_home")}
					</Button>
				</div>
			) : null}
		</div>
	);
}
