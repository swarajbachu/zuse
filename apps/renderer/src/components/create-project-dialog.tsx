import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import FolderAddIcon from "@hugeicons-pro/core-solid-rounded/FolderAddIcon";
import Layers01Icon from "@hugeicons-pro/core-solid-rounded/Layers01Icon";
import SourceCodeIcon from "@hugeicons-pro/core-solid-rounded/SourceCodeIcon";
import type { ProjectTemplate } from "@zuse/contracts";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { CheckboxInput } from "~/components/ui/checkbox-input";
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
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useWorkspaceStore } from "../store/workspace.ts";

interface CreateProjectDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

interface TemplateCard {
	readonly id: ProjectTemplate;
	readonly name: string;
	readonly blurb: string;
	readonly icon: IconSvgElement;
}

// Adding a 4th template is a one-line change here + a new branch in
// `project-scaffold-live.ts::createFromTemplate`.
const TEMPLATES: ReadonlyArray<TemplateCard> = [
	{
		id: "empty",
		name: "Empty",
		blurb: "Blank Git repo",
		icon: SourceCodeIcon,
	},
	{
		id: "nextjs",
		name: "Next.js",
		blurb: "TypeScript, Tailwind, App Router",
		icon: FolderAddIcon,
	},
	{
		id: "turborepo",
		name: "Turborepo",
		blurb: "Monorepo with apps + packages",
		icon: Layers01Icon,
	},
];

// Matches `PROJECT_NAME_REGEX` on the server so both sides reject the
// same input — keep these in sync if you ever loosen the rule.
const NAME_REGEX = /^[a-z0-9][a-z0-9-_]*$/;
const isValidName = (s: string): boolean => NAME_REGEX.test(s);

/**
 * "Create project" dialog: name + parent + template grid, with an optional
 * "also push a private GitHub repo" toggle when `gh` is signed in.
 */
export function CreateProjectDialog({
	open,
	onOpenChange,
}: CreateProjectDialogProps) {
	const loadGithubContext = useWorkspaceStore((s) => s.loadGithubContext);
	const ghAuthenticated = useWorkspaceStore((s) => s.ghAuthenticated);
	const pickFolder = useWorkspaceStore((s) => s.pickFolder);
	const createProject = useWorkspaceStore((s) => s.createProject);

	const [name, setName] = useState("");
	const [parent, setParent] = useState("");
	const [template, setTemplate] = useState<ProjectTemplate>("empty");
	const [alsoCreateGithubRepo, setAlsoCreateGithubRepo] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		if (ghAuthenticated === null) void loadGithubContext();
	}, [open, ghAuthenticated, loadGithubContext]);

	useEffect(() => {
		if (open) return;
		setName("");
		setError(null);
		setSubmitting(false);
		setTemplate("empty");
		setAlsoCreateGithubRepo(false);
	}, [open]);

	// If gh becomes unavailable while the dialog is open, untick the
	// checkbox so we don't surface a confusing "gh-create failed" error.
	useEffect(() => {
		if (ghAuthenticated === false) setAlsoCreateGithubRepo(false);
	}, [ghAuthenticated]);

	const onBrowse = async () => {
		const picked = await pickFolder();
		if (picked !== null) setParent(picked);
	};

	const trimmedName = name.trim();
	const nameError =
		trimmedName.length === 0
			? null
			: isValidName(trimmedName)
				? null
				: "Use lowercase letters, digits, dashes, underscores. Must start with a letter or digit.";
	const canSubmit = trimmedName.length > 0 && nameError === null && !submitting;

	const submit = async () => {
		if (!canSubmit) return;
		setSubmitting(true);
		setError(null);
		try {
			await createProject({
				name: trimmedName,
				parent: parent.trim(),
				template,
				alsoCreateGithubRepo,
			});
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			void submit();
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (submitting && !next) return;
		onOpenChange(next);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogPopup className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Create project</DialogTitle>
					<DialogDescription>
						Create a local folder
						{ghAuthenticated === true ? ", private GitHub repo, " : " "}
						and first workspace.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="flex flex-col gap-5" onKeyDown={onKeyDown}>
					<Field label="Project name">
						<Input
							value={name}
							onChange={(e) => setName(e.currentTarget.value)}
							placeholder="my-project"
							autoFocus
							aria-invalid={nameError !== null ? true : undefined}
						/>
						{nameError !== null ? (
							<p className="text-[11px] text-destructive">{nameError}</p>
						) : trimmedName.length > 0 ? (
							<p className="text-[11px] text-muted-foreground">
								Creates folder and repo{" "}
								<code className="rounded bg-muted/50 px-1 py-0.5">
									{trimmedName}
								</code>
							</p>
						) : null}
					</Field>

					<Field label="Parent folder">
						<div className="flex items-center gap-2">
							<Input
								value={parent}
								onChange={(e) => setParent(e.currentTarget.value)}
								placeholder="~/Developer"
							/>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => void onBrowse()}
							>
								Browse
							</Button>
						</div>
					</Field>

					<Field label="Template">
						<div className="grid grid-cols-3 gap-3">
							{TEMPLATES.map((tpl) => {
								const active = tpl.id === template;
								return (
									<button
										type="button"
										key={tpl.id}
										onClick={() => setTemplate(tpl.id)}
										className={cn(
											"flex flex-col items-center gap-2 rounded-md border border-transparent bg-muted px-3 py-5 text-center transition-colors ring-1 ring-inset ring-border/35",
											active
												? "bg-sidebar-accent text-sidebar-accent-foreground ring-foreground/20"
												: "hover:bg-sidebar-accent/70",
										)}
									>
										<span className="flex size-8 items-center justify-center rounded-md bg-background text-foreground">
											<HugeiconsIcon icon={tpl.icon} className="size-4" />
										</span>
										<span className="text-xs font-medium text-foreground">
											{tpl.name}
										</span>
										<span className="text-[10px] text-muted-foreground">
											{tpl.blurb}
										</span>
									</button>
								);
							})}
						</div>
					</Field>

					<label
						className={cn(
							"flex items-center gap-2 text-xs",
							ghAuthenticated === true
								? "text-foreground"
								: "text-muted-foreground/60",
						)}
					>
						<CheckboxInput
							checked={alsoCreateGithubRepo}
							onChange={(checked) => setAlsoCreateGithubRepo(checked)}
							disabled={ghAuthenticated !== true}
						/>
						Also create a private GitHub repo
						{ghAuthenticated === false && (
							<span className="text-[10px] italic">
								— run `gh auth login` first
							</span>
						)}
					</label>

					{error !== null && (
						<p className="text-[11px] text-destructive">{error}</p>
					)}
				</DialogPanel>

				<DialogFooter>
					<DialogClose
						render={
							<Button type="button" variant="ghost" disabled={submitting}>
								Cancel
							</Button>
						}
					/>
					<Button
						type="button"
						onClick={() => void submit()}
						disabled={!canSubmit}
						className="gap-2"
					>
						{submitting ? (
							<>
								<span className="inline-flex size-3.5 items-center justify-center">
									<Spinner className="size-3.5" />
								</span>
								Creating…
							</>
						) : (
							<>
								Create
								<kbd className="font-sans text-[10px] text-muted-foreground/80">
									⌘↩
								</kbd>
							</>
						)}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-xs font-medium text-foreground">{label}</span>
			{children}
		</div>
	);
}
