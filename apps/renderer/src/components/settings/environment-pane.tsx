import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type {
	EnvironmentEntry,
	EnvironmentProject,
	EnvironmentVaultCommand,
	EnvironmentVaultSnapshot,
} from "@zuse/contracts";
import {
	parseEnvironmentFile,
	validateEnvironmentName,
} from "@zuse/utils/environment";
import {
	Check,
	ChevronsUpDown,
	Copy,
	Eye,
	EyeOff,
	Info,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	Trash2,
	Upload,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "~/lib/utils";
import { useAuth } from "../../hooks/use-auth.ts";
import { useEnvironmentAuth } from "../../lib/auth-client-bus.ts";
import { copyText } from "../../lib/platform-capabilities.ts";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "../ui/alert-dialog.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { CompactEmptyState } from "../ui/compact-empty-state.tsx";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";
import {
	selectTriggerIconClassName,
	selectTriggerVariants,
} from "../ui/select.tsx";
import { SettingsFrame, SettingsGroup } from "../ui/settings-panel.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import { Switch } from "../ui/switch.tsx";
import { Textarea } from "../ui/textarea.tsx";
import {
	blankEnvironmentEntry,
	callEnvironmentVault,
	ENVIRONMENT_TARGET_LABEL,
	environmentVaultFailure,
} from "./environment-vault.ts";

type ImportedEntries = ReturnType<typeof parseEnvironmentFile>;

/** Rows above which the variable list grows a search field. */
const SEARCH_THRESHOLD = 6;

const nameProblem = (name: string): string | null => {
	if (name.length === 0) return null;
	try {
		validateEnvironmentName(name);
		return null;
	} catch (cause) {
		return cause instanceof Error &&
			cause.message === "reserved_environment_name"
			? "This name is reserved by Zuse or the runtime."
			: "Use letters, digits, and underscores. Start with a letter or underscore.";
	}
};

const projectName = (projects: ReadonlyArray<EnvironmentProject>, id: string) =>
	projects.find((project) => project.id === id)?.name ?? "Unknown project";

const assignmentSummary = (
	entry: EnvironmentEntry,
	projects: ReadonlyArray<EnvironmentProject>,
) => {
	const parts: string[] = [];
	if (entry.projectIds === null) {
		parts.push(
			entry.excludedProjectIds.length === 0
				? "All projects"
				: `All projects except ${entry.excludedProjectIds.length}`,
		);
	} else if (entry.projectIds.length <= 2) {
		parts.push(
			entry.projectIds.map((id) => projectName(projects, id)).join(", "),
		);
	} else {
		parts.push(`${entry.projectIds.length} projects`);
	}
	if (entry.target !== "both")
		parts.push(ENVIRONMENT_TARGET_LABEL[entry.target]);
	return parts.join(" · ");
};

/** Values live only in short-lived editor/reveal state, never a persisted UI store. */
export function EnvironmentPane() {
	const { user, isSignedIn } = useAuth();
	const auth = useEnvironmentAuth();
	const organization =
		auth.data?.state?._tag === "SignedIn"
			? auth.data.state.session.organizationId
			: null;
	return (
		<EnvironmentAccountPane
			key={JSON.stringify([user?.id ?? "signed-out", organization])}
			signedIn={isSignedIn}
		/>
	);
}

function EnvironmentAccountPane({ signedIn }: { signedIn: boolean }) {
	const [snapshot, setSnapshot] = useState<EnvironmentVaultSnapshot | null>(
		null,
	);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [editor, setEditor] = useState<EnvironmentEntry | null>(null);
	const [value, setValue] = useState("");
	const [replaceValue, setReplaceValue] = useState(false);
	const [revealed, setRevealed] = useState<{
		id: string;
		value: string;
	} | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<EnvironmentEntry | null>(null);
	const [newProject, setNewProject] = useState("");
	const [imported, setImported] = useState<ImportedEntries | null>(null);
	const [duplicates, setDuplicates] = useState<"skip" | "replace">("skip");
	const [changed, setChanged] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	useEffect(() => {
		if (!revealed) return;
		const timer = setTimeout(() => setRevealed(null), 30_000);
		return () => clearTimeout(timer);
	}, [revealed]);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(null), 1_500);
		return () => clearTimeout(timer);
	}, [copied]);
	const perform = useCallback(async (command: EnvironmentVaultCommand) => {
		setBusy(true);
		setError(null);
		try {
			const result = await callEnvironmentVault(command);
			if (!alive.current) return null;
			setSnapshot(result.snapshot);
			return result;
		} catch (cause) {
			if (alive.current) setError(environmentVaultFailure(cause));
			return null;
		} finally {
			if (alive.current) setBusy(false);
		}
	}, []);
	useEffect(() => {
		if (signedIn) void perform({ action: "list" });
	}, [signedIn, perform]);
	const edit = (entry: EnvironmentEntry) => {
		setEditor(entry);
		setValue("");
		setReplaceValue(!entry.id);
		setRevealed(null);
		setError(null);
	};
	const closeEditor = () => {
		setEditor(null);
		setValue("");
	};
	const save = async () => {
		if (!editor || !snapshot) return;
		const result = await perform({
			action: "save",
			expectedRevision: snapshot.revision,
			entry: editor,
			...(replaceValue ? { value } : {}),
		});
		if (result) {
			closeEditor();
			setChanged(true);
		}
	};
	const remove = async (entry: EnvironmentEntry) => {
		if (!snapshot) return;
		if (
			await perform({
				action: "delete",
				id: entry.id,
				expectedRevision: snapshot.revision,
			})
		) {
			setDeleting(null);
			setRevealed(null);
			setChanged(true);
		}
	};
	const reveal = async (entry: EnvironmentEntry) => {
		if (revealed?.id === entry.id) {
			setRevealed(null);
			return;
		}
		const result = await perform({ action: "reveal", id: entry.id });
		if (result?.value !== undefined)
			setRevealed({ id: entry.id, value: result.value });
	};
	const importFile = async (file: File | undefined) => {
		if (!file) return;
		try {
			if (file.size > 1_048_576) throw new Error();
			const entries = parseEnvironmentFile(await file.text());
			if (alive.current) {
				setImported(entries);
				setDuplicates("skip");
				setError(null);
			}
		} catch {
			setError(
				"Could not import this .env file. Check its syntax and size (maximum 1 MB).",
			);
		}
	};
	const saveImport = async () => {
		if (!snapshot || !imported) return;
		setBusy(true);
		setError(null);
		let current = snapshot;
		let completed = 0;
		try {
			for (const item of imported) {
				const existing = current.entries.find(
					(entry) =>
						entry.name === item.name &&
						entry.projectIds === null &&
						entry.target === "both",
				);
				if (existing && duplicates === "skip") {
					completed++;
					continue;
				}
				const result = await callEnvironmentVault({
					action: "save",
					expectedRevision: current.revision,
					entry: existing
						? { ...existing, kind: "secret" }
						: blankEnvironmentEntry({ name: item.name }),
					value: item.value,
				});
				current = result.snapshot;
				completed++;
				if (!alive.current) return;
				setSnapshot(current);
				setChanged(true);
			}
			setImported(null);
		} catch (cause) {
			if (alive.current) {
				setImported(imported.slice(completed));
				setError(
					`${completed} rows processed. ${environmentVaultFailure(cause)}`,
				);
			}
		} finally {
			if (alive.current) setBusy(false);
		}
	};
	const addProject = async () => {
		if (!snapshot) return;
		if (
			await perform({
				action: "project",
				name: newProject.trim(),
				expectedRevision: snapshot.revision,
			})
		)
			setNewProject("");
	};

	if (!signedIn)
		return (
			<SettingsFrame
				title="Sign in required"
				description="Environment values are stored with your Zuse account and shared across local and cloud workspaces."
			>
				<p className="text-xs text-muted-foreground">
					Sign in to manage variables and secrets.
				</p>
			</SettingsFrame>
		);

	if (snapshot && !snapshot.enabled)
		return (
			<SettingsFrame title="Not available yet">
				<p className="text-xs text-muted-foreground">
					Environment is not enabled on this deployment yet.
				</p>
			</SettingsFrame>
		);

	const filtered =
		snapshot?.entries.filter((entry) =>
			entry.name.toLowerCase().includes(query.trim().toLowerCase()),
		) ?? [];
	const dialogError = editor !== null || imported !== null || deleting !== null;

	return (
		<div className="flex flex-col gap-5">
			{error && !dialogError ? (
				<ErrorBanner
					message={error}
					busy={busy}
					onRetry={() => void perform({ action: "list" })}
				/>
			) : null}
			{changed && !error ? (
				<div
					role="status"
					className="flex items-start gap-2 rounded-lg bg-alert-info-bg px-3 py-2 text-[11px] leading-4 text-foreground"
				>
					<Info className="mt-px size-3.5 shrink-0 text-info" aria-hidden />
					<span className="flex-1">
						Saved. Restart running agents, terminals, and apps to pick up the
						new values.
					</span>
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground"
						onClick={() => setChanged(false)}
					>
						Dismiss
					</button>
				</div>
			) : null}

			<SettingsGroup
				title="Variables"
				description="Encrypted with your account and injected into agents, terminals, and scripts."
				action={
					<>
						<input
							ref={fileInput}
							aria-label="Import .env file"
							type="file"
							className="sr-only"
							tabIndex={-1}
							onChange={(event) => {
								void importFile(event.target.files?.[0]);
								event.target.value = "";
							}}
						/>
						<div className="flex items-center gap-1.5">
							<Button
								variant="settings"
								className="px-2.5"
								disabled={busy || !snapshot}
								onClick={() => fileInput.current?.click()}
							>
								<Upload aria-hidden />
								Import .env
							</Button>
							<Button
								className="px-2.5"
								disabled={busy || !snapshot}
								onClick={() => edit(blankEnvironmentEntry())}
							>
								<Plus aria-hidden />
								Add variable
							</Button>
						</div>
					</>
				}
			>
				{snapshot === null ? (
					error ? (
						<CompactEmptyState
							title="Variables could not be loaded"
							className="py-6"
						/>
					) : (
						<LoadingRows />
					)
				) : snapshot.entries.length === 0 ? (
					<CompactEmptyState
						className="py-8"
						title="No variables yet"
						description="Add a variable or import an existing .env file."
					/>
				) : (
					<>
						{snapshot.entries.length > SEARCH_THRESHOLD ? (
							<div className="relative px-2 py-1.5">
								<Search
									className="pointer-events-none absolute top-1/2 left-4.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
									aria-hidden
								/>
								<Input
									unstyled
									aria-label="Search environment variables"
									className="h-7 rounded-md bg-transparent pl-6 text-xs"
									placeholder="Search variables…"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
								/>
							</div>
						) : null}
						{filtered.map((entry) => (
							<VariableRow
								key={entry.id}
								entry={entry}
								summary={assignmentSummary(entry, snapshot.projects)}
								revealedValue={
									revealed?.id === entry.id ? revealed.value : null
								}
								copied={copied === entry.id}
								busy={busy}
								onEdit={() => edit(entry)}
								onReveal={() => void reveal(entry)}
								onCopy={(text) => {
									void copyText(text).then(() => setCopied(entry.id));
								}}
								onDelete={() => {
									setError(null);
									setDeleting(entry);
								}}
							/>
						))}
						{filtered.length === 0 ? (
							<CompactEmptyState
								className="py-5"
								title={`No variables match “${query.trim()}”`}
							/>
						) : null}
					</>
				)}
			</SettingsGroup>

			{snapshot ? (
				<SettingsGroup
					title="Projects"
					description="Link a repository to a project from its repository settings."
					action={
						<form
							className="flex items-center gap-1.5"
							onSubmit={(event) => {
								event.preventDefault();
								if (newProject.trim()) void addProject();
							}}
						>
							<Input
								aria-label="New project name"
								className="h-7 w-44"
								value={newProject}
								onChange={(event) => setNewProject(event.target.value)}
								placeholder="New project name"
							/>
							<Button
								type="submit"
								variant="settings"
								className="px-2.5"
								disabled={busy || !newProject.trim()}
							>
								Add
							</Button>
						</form>
					}
				>
					{snapshot.projects.length === 0 ? (
						<CompactEmptyState
							className="py-5"
							title="No projects yet"
							description="Projects appear here when a repository resolves its environment or when you add one."
						/>
					) : (
						snapshot.projects.map((project) => {
							const count = snapshot.entries.filter((entry) =>
								entry.projectIds?.includes(project.id),
							).length;
							return (
								<div
									key={project.id}
									className="flex h-9 items-center justify-between gap-3 px-3"
								>
									<span className="min-w-0 truncate text-xs text-foreground">
										{project.name}
									</span>
									<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
										{count === 0
											? "Account defaults only"
											: `${count} project ${count === 1 ? "value" : "values"}`}
									</span>
								</div>
							);
						})
					)}
				</SettingsGroup>
			) : null}

			{snapshot ? (
				<VariableEditorDialog
					entry={editor}
					projects={snapshot.projects}
					value={value}
					replaceValue={replaceValue}
					busy={busy}
					error={editor ? error : null}
					onChange={setEditor}
					onValueChange={setValue}
					onReplaceValue={() => setReplaceValue(true)}
					onClose={() => {
						if (!busy) closeEditor();
					}}
					onSave={() => void save()}
				/>
			) : null}

			<ImportDialog
				imported={imported}
				existingNames={
					new Set(
						snapshot?.entries
							.filter(
								(entry) => entry.projectIds === null && entry.target === "both",
							)
							.map((entry) => entry.name) ?? [],
					)
				}
				duplicates={duplicates}
				busy={busy}
				error={imported ? error : null}
				onDuplicatesChange={setDuplicates}
				onClose={() => {
					if (!busy) setImported(null);
				}}
				onImport={() => void saveImport()}
			/>

			<AlertDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setDeleting(null);
				}}
			>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
						<AlertDialogDescription>
							New agents, terminals, and scripts will no longer receive this
							value. Running processes keep their current environment.
						</AlertDialogDescription>
						{error && deleting ? (
							<p role="alert" className="text-[11px] text-destructive">
								{error}
							</p>
						) : null}
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							disabled={busy}
							render={<Button variant="ghost" />}
						>
							Cancel
						</AlertDialogClose>
						<Button
							variant="destructive"
							loading={busy}
							onClick={() => {
								if (deleting) void remove(deleting);
							}}
						>
							Delete
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</div>
	);
}

function ErrorBanner({
	message,
	busy,
	onRetry,
}: {
	message: string;
	busy: boolean;
	onRetry: () => void;
}) {
	return (
		<div
			role="alert"
			className="flex items-center gap-3 rounded-lg bg-alert-error-bg px-3 py-1.5 text-[11px] leading-4 text-destructive"
		>
			<span className="flex-1">{message}</span>
			<Button
				variant="ghost"
				className="px-2 text-destructive hover:bg-destructive/10"
				disabled={busy}
				onClick={onRetry}
			>
				<RefreshCw aria-hidden />
				Refresh
			</Button>
		</div>
	);
}

function LoadingRows() {
	return (
		<div role="status" aria-label="Loading environment">
			{[0, 1, 2].map((row) => (
				<div
					key={row}
					className="flex h-12 items-center gap-3 border-border px-3 not-last:border-b"
				>
					<div className="flex flex-1 flex-col gap-1.5">
						<Skeleton className="h-3 w-36" />
						<Skeleton className="h-2.5 w-24" />
					</div>
					<Skeleton className="h-5 w-28" />
				</div>
			))}
		</div>
	);
}

function VariableRow({
	entry,
	summary,
	revealedValue,
	copied,
	busy,
	onEdit,
	onReveal,
	onCopy,
	onDelete,
}: {
	entry: EnvironmentEntry;
	summary: string;
	revealedValue: string | null;
	copied: boolean;
	busy: boolean;
	onEdit: () => void;
	onReveal: () => void;
	onCopy: (value: string) => void;
	onDelete: () => void;
}) {
	const shown = revealedValue !== null;
	return (
		<div className="group flex min-h-12 items-center gap-3 px-3 py-1.5">
			<button
				type="button"
				className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left outline-none focus-visible:underline"
				onClick={onEdit}
			>
				<span className="flex max-w-full items-center gap-1.5">
					<span className="truncate font-mono text-xs font-medium text-foreground">
						{entry.name}
					</span>
					<Badge
						size="sm"
						variant={entry.kind === "secret" ? "outline" : "info"}
					>
						{entry.kind === "secret" ? "Secret" : "Variable"}
					</Badge>
				</span>
				<span className="max-w-full truncate text-[11px] text-muted-foreground">
					{summary}
				</span>
			</button>
			<span
				className={cn(
					"hidden h-6 max-w-52 items-center truncate rounded-md bg-muted/60 px-2 font-mono text-[11px] sm:inline-flex",
					shown ? "text-foreground" : "tracking-widest text-muted-foreground",
				)}
				title={shown ? undefined : "Hidden"}
			>
				<span className="truncate">{shown ? revealedValue : "••••••••"}</span>
			</span>
			<div className="flex shrink-0 items-center gap-0.5">
				<IconAction
					label={shown ? `Hide ${entry.name}` : `Reveal ${entry.name}`}
					disabled={busy}
					onClick={onReveal}
				>
					{shown ? <EyeOff /> : <Eye />}
				</IconAction>
				{shown ? (
					<IconAction
						label={`Copy ${entry.name}`}
						onClick={() => onCopy(revealedValue)}
					>
						{copied ? <Check className="text-success" /> : <Copy />}
					</IconAction>
				) : null}
				<IconAction
					label={`Edit ${entry.name}`}
					disabled={busy}
					onClick={onEdit}
				>
					<Pencil />
				</IconAction>
				<IconAction
					label={`Delete ${entry.name}`}
					disabled={busy}
					className="hover:text-destructive"
					onClick={onDelete}
				>
					<Trash2 />
				</IconAction>
			</div>
		</div>
	);
}

function IconAction({
	label,
	className,
	children,
	...props
}: {
	label: string;
	className?: string;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<Button
			size="icon"
			variant="ghost"
			aria-label={label}
			title={label}
			className={cn(
				"text-muted-foreground hover:text-foreground pointer-coarse:after:min-h-7 pointer-coarse:after:min-w-7",
				className,
			)}
			{...props}
		>
			{children}
		</Button>
	);
}

function Field({
	label,
	error,
	children,
}: {
	label: string;
	error?: string | null;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[11px] font-medium text-muted-foreground">
				{label}
			</span>
			{children}
			{error ? (
				<p className="text-[11px] leading-4 text-destructive">{error}</p>
			) : null}
		</div>
	);
}

function OptionRow({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
			<div className="min-w-0">
				<p className="text-xs font-medium leading-4 text-foreground">{title}</p>
				{description === undefined ? null : (
					<p className="text-[11px] leading-4 text-muted-foreground">
						{description}
					</p>
				)}
			</div>
			<div className="flex shrink-0 items-center">{children}</div>
		</div>
	);
}

function ProjectMultiSelect({
	label,
	placeholder,
	projects,
	value,
	onChange,
}: {
	label: string;
	placeholder: string;
	projects: ReadonlyArray<EnvironmentProject>;
	value: ReadonlyArray<string>;
	onChange: (ids: string[]) => void;
}) {
	const selected = projects.filter((project) => value.includes(project.id));
	return (
		<ComboboxPrimitive.Root
			multiple
			items={projects}
			value={selected}
			itemToStringLabel={(project: EnvironmentProject) => project.name}
			isItemEqualToValue={(a: EnvironmentProject, b: EnvironmentProject) =>
				a.id === b.id
			}
			onValueChange={(next) => onChange(next.map((project) => project.id))}
		>
			<ComboboxPrimitive.Trigger
				aria-label={label}
				className={cn(selectTriggerVariants(), "w-44")}
			>
				<span className="flex-1 truncate">
					{selected.length === 0 ? (
						<span className="text-muted-foreground">{placeholder}</span>
					) : selected.length <= 2 ? (
						selected.map((project) => project.name).join(", ")
					) : (
						`${selected.length} projects`
					)}
				</span>
				<ChevronsUpDown className={selectTriggerIconClassName} />
			</ComboboxPrimitive.Trigger>
			<ComboboxPrimitive.Portal>
				<ComboboxPrimitive.Positioner
					align="end"
					sideOffset={4}
					className="z-50 select-none"
				>
					<ComboboxPrimitive.Popup className="w-60 overflow-hidden rounded-lg border border-border/80 bg-popover text-foreground shadow-overlay outline-none">
						<div className="relative border-border/60 border-b">
							<Search
								className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
								aria-hidden
							/>
							<ComboboxPrimitive.Input
								aria-label="Search projects"
								placeholder="Search projects…"
								className="h-7 w-full bg-transparent pr-2.5 pl-7 text-xs outline-none placeholder:text-muted-foreground/72"
							/>
						</div>
						<ComboboxPrimitive.Empty className="px-3 py-2 text-[11px] text-muted-foreground empty:hidden">
							No matching projects.
						</ComboboxPrimitive.Empty>
						<ComboboxPrimitive.List className="max-h-56 overflow-y-auto p-1 empty:hidden">
							{(project: EnvironmentProject) => (
								<ComboboxPrimitive.Item
									key={project.id}
									value={project}
									className="grid min-h-7 cursor-default grid-cols-[0.875rem_1fr] items-center gap-1.5 rounded-md ps-1.5 pe-3 text-xs outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
								>
									<ComboboxPrimitive.ItemIndicator className="col-start-1">
										<Check className="size-3.5" aria-hidden />
									</ComboboxPrimitive.ItemIndicator>
									<span className="col-start-2 min-w-0 truncate">
										{project.name}
									</span>
								</ComboboxPrimitive.Item>
							)}
						</ComboboxPrimitive.List>
					</ComboboxPrimitive.Popup>
				</ComboboxPrimitive.Positioner>
			</ComboboxPrimitive.Portal>
		</ComboboxPrimitive.Root>
	);
}

function VariableEditorDialog({
	entry,
	projects,
	value,
	replaceValue,
	busy,
	error,
	onChange,
	onValueChange,
	onReplaceValue,
	onClose,
	onSave,
}: {
	entry: EnvironmentEntry | null;
	projects: ReadonlyArray<EnvironmentProject>;
	value: string;
	replaceValue: boolean;
	busy: boolean;
	error: string | null;
	onChange: (entry: EnvironmentEntry) => void;
	onValueChange: (value: string) => void;
	onReplaceValue: () => void;
	onClose: () => void;
	onSave: () => void;
}) {
	// Keep the last entry rendered while the popup animates closed.
	const last = useRef(entry);
	if (entry) last.current = entry;
	const current = entry ?? last.current;
	if (!current) return null;
	const allProjects = current.projectIds === null;
	const problem = nameProblem(current.name);
	const canSave =
		!busy &&
		current.name.length > 0 &&
		problem === null &&
		current.projectIds?.length !== 0;

	return (
		<Dialog
			open={entry !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogPopup className="max-w-md">
				<form
					className="flex min-h-0 flex-col"
					onSubmit={(event) => {
						event.preventDefault();
						if (canSave) onSave();
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{current.id ? "Edit variable" : "Add variable"}
						</DialogTitle>
					</DialogHeader>
					<DialogPanel className="flex flex-col gap-3">
						<Field label="Name" error={problem}>
							<Input
								aria-label="Variable name"
								aria-invalid={problem !== null || undefined}
								className="font-mono"
								autoFocus={!current.id}
								autoComplete="off"
								spellCheck={false}
								required
								value={current.name}
								placeholder="DATABASE_URL"
								onChange={(event) =>
									onChange({ ...current, name: event.target.value })
								}
							/>
						</Field>
						<Field label="Value">
							{replaceValue ? (
								<Textarea
									aria-label="Variable value"
									className="font-mono"
									autoFocus={Boolean(current.id)}
									autoComplete="off"
									spellCheck={false}
									value={value}
									onChange={(event) => onValueChange(event.target.value)}
									placeholder="Paste a value"
								/>
							) : (
								<div className="flex h-7 items-center justify-between gap-2 rounded-md bg-muted/60 pr-0.5 pl-2.5">
									<span className="font-mono text-[11px] tracking-widest text-muted-foreground">
										••••••••
									</span>
									<Button
										variant="ghost"
										size="sm"
										className="h-6"
										onClick={onReplaceValue}
									>
										Replace value
									</Button>
								</div>
							)}
						</Field>
						<div className="mt-1 flex flex-col divide-y divide-border/60 rounded-lg bg-muted/40">
							<OptionRow
								title="Secret"
								description="Masked in terminal output and transcripts."
							>
								<Switch
									aria-label="Secret"
									checked={current.kind === "secret"}
									onCheckedChange={(secret) =>
										onChange({
											...current,
											kind: secret ? "secret" : "variable",
										})
									}
								/>
							</OptionRow>
							<OptionRow
								title="All projects"
								description="Includes projects added later."
							>
								<Switch
									aria-label="All projects"
									checked={allProjects}
									disabled={allProjects && projects.length === 0}
									onCheckedChange={(all) =>
										onChange({
											...current,
											projectIds: all ? null : [],
											excludedProjectIds: [],
										})
									}
								/>
							</OptionRow>
							{projects.length > 0 ? (
								<OptionRow
									title={allProjects ? "Except" : "Projects"}
									description={
										!allProjects && current.projectIds?.length === 0
											? "Select at least one project."
											: undefined
									}
								>
									<ProjectMultiSelect
										label={allProjects ? "Excluded projects" : "Projects"}
										placeholder={allProjects ? "None" : "Select projects"}
										projects={projects}
										value={
											allProjects
												? current.excludedProjectIds
												: (current.projectIds ?? [])
										}
										onChange={(ids) =>
											onChange(
												allProjects
													? { ...current, excludedProjectIds: ids }
													: { ...current, projectIds: ids },
											)
										}
									/>
								</OptionRow>
							) : null}
						</div>
						{error ? (
							<p
								role="alert"
								className="text-[11px] leading-4 text-destructive"
							>
								{error}
							</p>
						) : null}
					</DialogPanel>
					<DialogFooter>
						<DialogClose
							disabled={busy}
							render={<Button type="button" variant="ghost" />}
						>
							Cancel
						</DialogClose>
						<Button type="submit" loading={busy} disabled={!canSave}>
							{current.id ? "Save changes" : "Add variable"}
						</Button>
					</DialogFooter>
				</form>
			</DialogPopup>
		</Dialog>
	);
}

function ImportDialog({
	imported,
	existingNames,
	duplicates,
	busy,
	error,
	onDuplicatesChange,
	onClose,
	onImport,
}: {
	imported: ImportedEntries | null;
	existingNames: ReadonlySet<string>;
	duplicates: "skip" | "replace";
	busy: boolean;
	error: string | null;
	onDuplicatesChange: (value: "skip" | "replace") => void;
	onClose: () => void;
	onImport: () => void;
}) {
	const last = useRef(imported);
	if (imported) last.current = imported;
	const items = imported ?? last.current ?? [];
	const conflicts = items.filter((item) => existingNames.has(item.name)).length;
	const count = duplicates === "skip" ? items.length - conflicts : items.length;
	return (
		<Dialog
			open={imported !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogPopup className="max-w-md">
				<DialogHeader>
					<DialogTitle>Import .env</DialogTitle>
					<DialogDescription>
						{items.length} {items.length === 1 ? "entry" : "entries"} will be
						saved as secrets for all projects.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="flex flex-col gap-4">
					{items.length === 0 ? (
						<CompactEmptyState
							title="Nothing to import"
							description="The file has no variable assignments."
						/>
					) : (
						<div className="flex max-h-48 flex-col overflow-y-auto rounded-md bg-muted/40 py-1">
							{items.map((item) => (
								<div
									key={item.name}
									className="flex h-7 items-center justify-between gap-2 px-2.5"
								>
									<span className="truncate font-mono text-xs">
										{item.name}
									</span>
									{existingNames.has(item.name) ? (
										<Badge size="sm" variant="warning">
											{duplicates === "skip" ? "Skipped" : "Replaces existing"}
										</Badge>
									) : (
										<Badge size="sm" variant="success">
											New
										</Badge>
									)}
								</div>
							))}
						</div>
					)}
					{conflicts > 0 ? (
						<div className="rounded-lg bg-muted/40">
							<OptionRow
								title="Replace existing values"
								description={`${conflicts} ${conflicts === 1 ? "name already exists" : "names already exist"}.`}
							>
								<Switch
									aria-label="Replace existing values"
									checked={duplicates === "replace"}
									onCheckedChange={(replace) =>
										onDuplicatesChange(replace ? "replace" : "skip")
									}
								/>
							</OptionRow>
						</div>
					) : null}
					{error ? (
						<p role="alert" className="text-[11px] leading-4 text-destructive">
							{error}
						</p>
					) : null}
				</DialogPanel>
				<DialogFooter>
					<DialogClose
						disabled={busy}
						render={<Button type="button" variant="ghost" />}
					>
						Cancel
					</DialogClose>
					<Button
						loading={busy}
						disabled={busy || count === 0}
						onClick={onImport}
					>
						Import {count} {count === 1 ? "secret" : "secrets"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
