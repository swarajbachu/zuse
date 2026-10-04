import type { EnvironmentEntry, EnvironmentProject } from "@zuse/contracts";
import { AlertCircle, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button.tsx";
import { CheckboxInput } from "../ui/checkbox-input.tsx";
import { Input } from "../ui/input.tsx";
import {
	Sheet,
	SheetBody,
	SheetClose,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetPopup,
	SheetTitle,
} from "../ui/sheet.tsx";
import { Switch } from "../ui/switch.tsx";
import { Textarea } from "../ui/textarea.tsx";
import {
	commonDraftProjects,
	type EnvironmentDraft,
	type EnvironmentDraftStatus,
	emptyEnvironmentDraft,
	environmentDraftStatuses,
	MAX_ENVIRONMENT_DRAFTS,
	mergePastedDrafts,
	parsePastedEnvironment,
} from "./environment-drafts.ts";
import { ProjectScopeSelect } from "./environment-fields.tsx";

export type EnvironmentBulkAddSession = {
	readonly id: string;
	readonly drafts: ReadonlyArray<EnvironmentDraft>;
};

export type EnvironmentBulkSave = {
	readonly drafts: ReadonlyArray<EnvironmentDraft>;
	readonly kind: EnvironmentEntry["kind"];
};

/** Rows above which the list grows search and issue filters. */
const FILTER_THRESHOLD = 8;
const ROW_GRID =
	"grid grid-cols-[1rem_minmax(0,1fr)_minmax(0,1.3fr)_8.5rem_1.75rem] items-start gap-1.5";

const isBlank = (draft: EnvironmentDraft) =>
	draft.name.length === 0 && draft.value.length === 0;

/**
 * Adds many variables at once in a side sheet. Pasting dotenv text fills rows;
 * each row applies to all projects unless it picks its own.
 */
export function EnvironmentBulkAddSheet({
	session,
	projects,
	entries,
	busy,
	error,
	onClose,
	onSave,
}: {
	session: EnvironmentBulkAddSession | null;
	projects: ReadonlyArray<EnvironmentProject>;
	entries: ReadonlyArray<EnvironmentEntry>;
	busy: boolean;
	error: string | null;
	onClose: () => void;
	/** Resolves with the keys of rows that were saved. */
	onSave: (input: EnvironmentBulkSave) => Promise<ReadonlySet<string>>;
}) {
	// Keep the last session rendered while the sheet animates closed.
	const last = useRef(session);
	if (session) last.current = session;
	const current = session ?? last.current;
	return (
		<Sheet
			open={session !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<SheetPopup>
				{current ? (
					<BulkAddForm
						key={current.id}
						initialDrafts={current.drafts}
						projects={projects}
						entries={entries}
						busy={busy}
						error={error}
						onSave={onSave}
					/>
				) : null}
			</SheetPopup>
		</Sheet>
	);
}

function BulkAddForm({
	initialDrafts,
	projects,
	entries,
	busy,
	error,
	onSave,
}: {
	initialDrafts: ReadonlyArray<EnvironmentDraft>;
	projects: ReadonlyArray<EnvironmentProject>;
	entries: ReadonlyArray<EnvironmentEntry>;
	busy: boolean;
	error: string | null;
	onSave: (input: EnvironmentBulkSave) => Promise<ReadonlySet<string>>;
}) {
	const [drafts, setDrafts] = useState<ReadonlyArray<EnvironmentDraft>>(
		initialDrafts.length > 0 ? initialDrafts : [emptyEnvironmentDraft()],
	);
	const [manual, setManual] = useState(initialDrafts.length > 0);
	const [pasteText, setPasteText] = useState("");
	const [pasteError, setPasteError] = useState<string | null>(null);
	const [secret, setSecret] = useState(true);
	const [query, setQuery] = useState("");
	const [issuesOnly, setIssuesOnly] = useState(false);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [dragging, setDragging] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	const statuses = environmentDraftStatuses(drafts, entries);
	const statusByKey = new Map(
		drafts.map((draft, index) => [
			draft.key,
			statuses[index] ?? ({ kind: "empty" } as const),
		]),
	);
	const filled = statuses.filter((status) => status.kind !== "empty");
	const issues = filled.filter((status) => status.kind === "invalid").length;
	const updates = filled.filter((status) => status.kind === "update").length;
	const canSave = !busy && filled.length > 0 && issues === 0;
	const showPasteZone = !manual && drafts.length === 1 && drafts.every(isBlank);
	const showFilters = drafts.length > FILTER_THRESHOLD || issuesOnly;
	const needle = query.trim().toLowerCase();
	const visible = drafts.filter(
		(draft) =>
			(!needle || draft.name.toLowerCase().includes(needle)) &&
			(!issuesOnly || statusByKey.get(draft.key)?.kind === "invalid"),
	);
	const selectedVisible = visible.filter((draft) => selected.has(draft.key));
	// The toolbar project picker edits the selection, or every filled row.
	const bulkTargets =
		selectedVisible.length > 0
			? selectedVisible
			: drafts.filter((draft) => !isBlank(draft));

	const update = (key: string, patch: Partial<EnvironmentDraft>) =>
		setDrafts((rows) =>
			rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
		);
	const insertParsed = (text: string, index: number) => {
		const parsed = parsePastedEnvironment(text, "name");
		if (!parsed) return false;
		setDrafts((rows) => {
			const base = rows.filter((row) => !isBlank(row));
			return mergePastedDrafts(base, Math.min(index, base.length), parsed);
		});
		setManual(true);
		setPasteText("");
		setPasteError(null);
		return true;
	};
	const pasteIntoRow =
		(index: number, field: "name" | "value") =>
		(event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			const parsed = parsePastedEnvironment(
				event.clipboardData.getData("text"),
				field,
			);
			if (!parsed) return;
			event.preventDefault();
			setDrafts((rows) => mergePastedDrafts(rows, index, parsed));
		};
	const readFile = async (file: File | undefined) => {
		if (!file) return;
		if (
			file.size > 1_048_576 ||
			!insertParsed(await file.text(), drafts.length)
		)
			setPasteError("No NAME=value lines found in that file.");
	};
	const dropHandlers = {
		onDragOver: (event: DragEvent) => {
			if (!event.dataTransfer.types.includes("Files")) return;
			event.preventDefault();
			setDragging(true);
		},
		onDragLeave: () => setDragging(false),
		onDrop: (event: DragEvent) => {
			if (!event.dataTransfer.types.includes("Files")) return;
			event.preventDefault();
			setDragging(false);
			void readFile(event.dataTransfer.files[0]);
		},
	};
	const removeRows = (keys: ReadonlySet<string>) => {
		setDrafts((rows) => {
			const remaining = rows.filter((row) => !keys.has(row.key));
			return remaining.length > 0 ? remaining : [emptyEnvironmentDraft()];
		});
		setSelected(new Set());
	};
	const toggleAll = (checked: boolean) =>
		setSelected(
			checked ? new Set(visible.map((draft) => draft.key)) : new Set(),
		);
	const submit = async () => {
		const saved = await onSave({
			drafts: drafts.filter(
				(draft) => statusByKey.get(draft.key)?.kind !== "empty",
			),
			kind: secret ? "secret" : "variable",
		});
		setDrafts((rows) => {
			const remaining = rows.filter((row) => !saved.has(row.key));
			return remaining.length > 0 ? remaining : [emptyEnvironmentDraft()];
		});
		setSelected(new Set());
	};

	return (
		<form
			className="flex min-h-0 flex-1 flex-col"
			onSubmit={(event) => {
				event.preventDefault();
				if (canSave) void submit();
			}}
		>
			<input
				ref={fileInput}
				type="file"
				className="sr-only"
				tabIndex={-1}
				aria-label="Choose .env file"
				onChange={(event) => {
					void readFile(event.target.files?.[0]);
					event.target.value = "";
				}}
			/>
			<SheetHeader className="pr-12">
				<SheetTitle>Add variables</SheetTitle>
				<SheetDescription>
					Paste or drop a .env file. Every line becomes a row you can review
					before saving.
				</SheetDescription>
			</SheetHeader>

			<div className="flex shrink-0 flex-col gap-2 px-4 pb-3">
				{showPasteZone ? null : (
					<>
						<div className="flex h-7 items-center gap-2">
							{selectedVisible.length > 0 ? (
								<>
									<span className="text-xs font-medium tabular-nums">
										{selectedVisible.length} selected
									</span>
									<Button
										variant="ghost"
										className="px-2 text-muted-foreground hover:text-destructive"
										onClick={() => removeRows(selected)}
									>
										<Trash2 aria-hidden />
										Remove
									</Button>
									<Button
										variant="ghost"
										className="px-2 text-muted-foreground"
										onClick={() => setSelected(new Set())}
									>
										Clear
									</Button>
								</>
							) : (
								<>
									<span className="text-xs text-muted-foreground tabular-nums">
										{filled.length}{" "}
										{filled.length === 1 ? "variable" : "variables"}
										{updates > 0
											? ` · ${updates} ${updates === 1 ? "update" : "updates"}`
											: ""}
									</span>
									{issues > 0 ? (
										<Button
											variant="ghost"
											className={cn(
												"px-2 text-destructive hover:text-destructive",
												issuesOnly && "bg-alert-error-bg",
											)}
											aria-pressed={issuesOnly}
											onClick={() => setIssuesOnly((value) => !value)}
										>
											<AlertCircle aria-hidden />
											{issues} {issues === 1 ? "issue" : "issues"}
										</Button>
									) : null}
								</>
							)}
							<div className="ml-auto flex items-center gap-2">
								{showFilters && selectedVisible.length === 0 ? (
									<div className="relative w-40">
										<Search
											className="pointer-events-none absolute top-1/2 left-2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
											aria-hidden
										/>
										<Input
											aria-label="Filter rows"
											className="pl-5"
											placeholder="Filter…"
											value={query}
											onChange={(event) => setQuery(event.target.value)}
										/>
									</div>
								) : null}
								{projects.length > 0 && bulkTargets.length > 0 ? (
									<span className="text-[11px] text-muted-foreground">
										{selectedVisible.length > 0 ? "Set selected" : "Set all"}
									</span>
								) : null}
								{projects.length > 0 && bulkTargets.length > 0 ? (
									<ProjectScopeSelect
										label={
											selectedVisible.length > 0
												? "Projects for selected rows"
												: "Projects for all rows"
										}
										className="w-40"
										projects={projects}
										value={commonDraftProjects(bulkTargets)}
										onChange={(projectIds) => {
											const keys = new Set(bulkTargets.map((row) => row.key));
											setDrafts((rows) =>
												rows.map((row) =>
													keys.has(row.key) ? { ...row, projectIds } : row,
												),
											);
										}}
									/>
								) : null}
							</div>
						</div>
						<div
							className={cn(
								ROW_GRID,
								"items-center text-[11px] font-medium text-muted-foreground",
							)}
						>
							<CheckboxInput
								checked={
									visible.length > 0 &&
									selectedVisible.length === visible.length
								}
								onChange={toggleAll}
							/>
							<span>Name</span>
							<span>Value</span>
							<span>Projects</span>
						</div>
					</>
				)}
			</div>

			<SheetBody
				className={cn("transition-colors", dragging && "bg-muted/40")}
				{...dropHandlers}
			>
				{showPasteZone ? (
					<PasteZone
						text={pasteText}
						error={pasteError}
						onTextChange={(text) => {
							setPasteText(text);
							setPasteError(null);
						}}
						onPaste={(text) => insertParsed(text, 0)}
						onParse={() => {
							if (!insertParsed(pasteText, 0))
								setPasteError("No NAME=value lines found.");
						}}
						onChooseFile={() => fileInput.current?.click()}
						onManual={() => setManual(true)}
					/>
				) : (
					<div className="flex flex-col gap-1">
						{visible.map((draft) => {
							const index = drafts.indexOf(draft);
							return (
								<DraftRow
									key={draft.key}
									draft={draft}
									index={index}
									status={statusByKey.get(draft.key) ?? { kind: "empty" }}
									projects={projects}
									selected={selected.has(draft.key)}
									autoFocus={
										index === drafts.length - 1 && isBlank(draft) && manual
									}
									onSelect={(checked) =>
										setSelected((keys) => {
											const next = new Set(keys);
											if (checked) next.add(draft.key);
											else next.delete(draft.key);
											return next;
										})
									}
									onChange={(patch) => update(draft.key, patch)}
									onPaste={pasteIntoRow}
									onRemove={() => removeRows(new Set([draft.key]))}
								/>
							);
						})}
						{visible.length === 0 ? (
							<p className="py-6 text-center text-[11px] text-muted-foreground">
								No rows match.
							</p>
						) : null}
						<div className="flex items-center gap-1 pt-1">
							<Button
								variant="ghost"
								className="-ml-2 px-2 text-muted-foreground hover:text-foreground"
								disabled={drafts.length >= MAX_ENVIRONMENT_DRAFTS}
								onClick={() => {
									setQuery("");
									setIssuesOnly(false);
									setDrafts((rows) => [...rows, emptyEnvironmentDraft()]);
								}}
							>
								<Plus aria-hidden />
								Add row
							</Button>
							<Button
								variant="ghost"
								className="px-2 text-muted-foreground hover:text-foreground"
								onClick={() => fileInput.current?.click()}
							>
								<Upload aria-hidden />
								Import .env
							</Button>
							{pasteError ? (
								<span className="text-[11px] text-destructive">
									{pasteError}
								</span>
							) : null}
						</div>
					</div>
				)}
			</SheetBody>

			<SheetFooter>
				<div className="mr-auto flex min-w-0 items-center gap-3">
					<InlineSwitch
						label="Secret"
						hint="Masked in logs and transcripts"
						checked={secret}
						onCheckedChange={setSecret}
					/>
					{error ? (
						<p
							role="alert"
							className="min-w-0 truncate text-[11px] text-destructive"
							title={error}
						>
							{error}
						</p>
					) : null}
				</div>
				<SheetClose
					disabled={busy}
					render={<Button type="button" variant="ghost" />}
				>
					Cancel
				</SheetClose>
				<Button type="submit" loading={busy} disabled={!canSave}>
					{filled.length > 1 ? `Save ${filled.length} variables` : "Save"}
				</Button>
			</SheetFooter>
		</form>
	);
}

function InlineSwitch({
	label,
	hint,
	checked,
	onCheckedChange,
}: {
	label: string;
	hint: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<span className="flex h-7 shrink-0 items-center gap-2" title={hint}>
			<Switch
				aria-label={label}
				checked={checked}
				onCheckedChange={onCheckedChange}
			/>
			<span className="text-xs text-foreground">{label}</span>
			<span className="text-[11px] text-muted-foreground max-sm:hidden">
				{hint}
			</span>
		</span>
	);
}

function PasteZone({
	text,
	error,
	onTextChange,
	onPaste,
	onParse,
	onChooseFile,
	onManual,
}: {
	text: string;
	error: string | null;
	onTextChange: (text: string) => void;
	onPaste: (text: string) => boolean;
	onParse: () => void;
	onChooseFile: () => void;
	onManual: () => void;
}) {
	return (
		<div className="flex flex-col gap-2">
			<Textarea
				aria-label="Paste .env contents"
				className="font-mono [&_textarea]:min-h-64"
				autoFocus
				autoComplete="off"
				spellCheck={false}
				value={text}
				placeholder={
					"Paste your .env here\n\nDATABASE_URL=postgres://…\nOPENAI_API_KEY=sk-…\nSTRIPE_SECRET_KEY=sk_live_…"
				}
				onPaste={(event) => {
					if (onPaste(event.clipboardData.getData("text")))
						event.preventDefault();
				}}
				onChange={(event) => onTextChange(event.target.value)}
			/>
			<div className="flex items-center gap-1">
				{text.trim() ? <Button onClick={onParse}>Create rows</Button> : null}
				<Button
					variant="ghost"
					className="px-2 text-muted-foreground hover:text-foreground"
					onClick={onChooseFile}
				>
					<Upload aria-hidden />
					Choose .env file
				</Button>
				<Button
					variant="ghost"
					className="px-2 text-muted-foreground hover:text-foreground"
					onClick={onManual}
				>
					<Plus aria-hidden />
					Add one by one
				</Button>
				{error ? (
					<span className="text-[11px] text-destructive">{error}</span>
				) : null}
			</div>
		</div>
	);
}

function DraftRow({
	draft,
	index,
	status,
	projects,
	selected,
	autoFocus,
	onSelect,
	onChange,
	onPaste,
	onRemove,
}: {
	draft: EnvironmentDraft;
	index: number;
	status: EnvironmentDraftStatus;
	projects: ReadonlyArray<EnvironmentProject>;
	selected: boolean;
	autoFocus: boolean;
	onSelect: (checked: boolean) => void;
	onChange: (patch: Partial<EnvironmentDraft>) => void;
	onPaste: (
		index: number,
		field: "name" | "value",
	) => (event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
	onRemove: () => void;
}) {
	const invalid = status.kind === "invalid";
	return (
		<div
			className={cn(
				"flex flex-col gap-0.5 rounded-md",
				selected && "bg-accent/40",
			)}
		>
			<div className={ROW_GRID}>
				<CheckboxInput
					className="mt-1.5"
					checked={selected}
					onChange={onSelect}
				/>
				<Input
					aria-label={`Name ${index + 1}`}
					aria-invalid={invalid || undefined}
					className="font-mono"
					autoFocus={autoFocus}
					autoComplete="off"
					spellCheck={false}
					placeholder="NAME"
					value={draft.name}
					onPaste={onPaste(index, "name")}
					onChange={(event) => onChange({ name: event.target.value })}
				/>
				{draft.value.includes("\n") ? (
					<Textarea
						size="sm"
						aria-label={`Value ${index + 1}`}
						className="font-mono"
						autoComplete="off"
						spellCheck={false}
						value={draft.value}
						onPaste={onPaste(index, "value")}
						onChange={(event) => onChange({ value: event.target.value })}
					/>
				) : (
					<Input
						aria-label={`Value ${index + 1}`}
						className="font-mono"
						autoComplete="off"
						spellCheck={false}
						placeholder="value"
						value={draft.value}
						onPaste={onPaste(index, "value")}
						onChange={(event) => onChange({ value: event.target.value })}
					/>
				)}
				<ProjectScopeSelect
					label={`Projects ${index + 1}`}
					className="w-full min-w-0"
					projects={projects}
					value={draft.projectIds}
					onChange={(projectIds) => onChange({ projectIds })}
				/>
				<Button
					size="icon"
					variant="ghost"
					aria-label={`Remove row ${index + 1}`}
					title="Remove"
					className="text-muted-foreground hover:text-foreground"
					onClick={onRemove}
				>
					<X />
				</Button>
			</div>
			{status.kind === "invalid" ? (
				<p className="pl-5.5 text-[11px] leading-4 text-destructive">
					{status.message}
				</p>
			) : status.kind === "update" ? (
				<p className="pl-5.5 text-[11px] leading-4 text-muted-foreground">
					Replaces the stored value.
				</p>
			) : null}
		</div>
	);
}
