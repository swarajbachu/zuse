import type { CloudProject, GithubRepoSummary } from "@zuse/contracts";
import { Check, Lock, Plus, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar.tsx";
import { Button } from "../ui/button.tsx";
import { CompactEmptyState } from "../ui/compact-empty-state.tsx";
import { Input } from "../ui/input.tsx";
import {
	Popover,
	PopoverClose,
	PopoverPopup,
	PopoverTrigger,
} from "../ui/popover.tsx";
import {
	CloudSettingsGroup,
	COMPACT_CLOUD_ACTION,
} from "./cloud-settings-ui.tsx";

function RepositoryAvatar({
	repository,
	name,
}: {
	repository?: GithubRepoSummary;
	readonly name: string;
}) {
	const owner = name.split("/")[0] ?? name;
	const avatarUrl =
		repository?.ownerAvatarUrl ??
		`https://github.com/${encodeURIComponent(owner)}.png?size=80`;
	return (
		<Avatar className="size-6 rounded-md">
			<AvatarImage
				src={avatarUrl}
				alt={`${owner} avatar`}
				referrerPolicy="no-referrer"
			/>
			<AvatarFallback className="rounded-md text-[9px]">
				{owner.slice(0, 2).toUpperCase()}
			</AvatarFallback>
		</Avatar>
	);
}

export function CloudWorkspaceRepositories({
	projects,
	repositories,
	githubAuthenticated,
	loading,
	busy,
	error,
	onRefresh,
	onAdd,
	onRemove,
}: {
	readonly projects: ReadonlyArray<CloudProject>;
	readonly repositories: ReadonlyArray<GithubRepoSummary>;
	readonly githubAuthenticated: boolean;
	readonly loading: boolean;
	readonly busy: string | null;
	readonly error: string | null;
	readonly onRefresh: () => void;
	readonly onAdd: (names: ReadonlyArray<string>) => void;
	readonly onRemove: (project: CloudProject) => void;
}) {
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<ReadonlyArray<string>>([]);
	const connected = useMemo(
		() =>
			new Set(
				projects.map((project) =>
					project.repositoryIdentity
						.replace(/^github\.com\//u, "")
						.toLowerCase(),
				),
			),
		[projects],
	);
	const available = repositories.filter(
		(repository) => !connected.has(repository.nameWithOwner.toLowerCase()),
	);
	const normalizedSearch = search.trim().toLowerCase();
	const filtered =
		normalizedSearch.length === 0
			? available
			: available.filter(
					(repository) =>
						repository.nameWithOwner.toLowerCase().includes(normalizedSearch) ||
						repository.description?.toLowerCase().includes(normalizedSearch),
				);

	return (
		<CloudSettingsGroup
			title="Repositories"
			description="Choose the personal, organization, and collaborator repositories included in your private cloud image."
			action={
				<Popover>
					<PopoverTrigger
						className={`inline-flex items-center gap-1.5 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground outline-none hover:bg-primary/90 disabled:opacity-50 ${COMPACT_CLOUD_ACTION}`}
						disabled={!githubAuthenticated || loading}
					>
						<Plus className="size-3.5" aria-hidden />
						Repository
					</PopoverTrigger>
					<PopoverPopup
						align="end"
						className="w-[min(34rem,var(--available-width))] min-w-[22rem] [&_[data-slot=popover-viewport]]:p-2"
					>
						<div className="flex items-center gap-2">
							<Input
								type="search"
								className="h-7"
								value={search}
								onChange={(event) => setSearch(event.currentTarget.value)}
								placeholder="Search personal and organization repositories"
								autoFocus
							/>
							<Button
								size="icon"
								className={`size-7 ${COMPACT_CLOUD_ACTION}`}
								variant="ghost"
								aria-label="Refresh GitHub repositories"
								loading={loading}
								onClick={onRefresh}
							>
								<RefreshCw aria-hidden />
							</Button>
						</div>
						<div className="mt-2 max-h-72 overflow-y-auto rounded-md bg-muted/30 p-1">
							{filtered.length === 0 ? (
								<p className="px-2 py-5 text-center text-[11px] text-muted-foreground">
									{available.length === 0
										? "Every available repository is already included."
										: "No repositories match this search."}
								</p>
							) : (
								filtered.map((repository) => {
									const isSelected = selected.includes(
										repository.nameWithOwner,
									);
									return (
										<button
											key={repository.nameWithOwner}
											type="button"
											className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-muted"
											onClick={() =>
												setSelected((current) =>
													isSelected
														? current.filter(
																(name) => name !== repository.nameWithOwner,
															)
														: [...current, repository.nameWithOwner],
												)
											}
										>
											<RepositoryAvatar
												repository={repository}
												name={repository.nameWithOwner}
											/>
											<span className="min-w-0 flex-1 truncate">
												{repository.nameWithOwner}
											</span>
											{repository.isPrivate ? (
												<Lock
													className="size-3 text-muted-foreground"
													aria-label="Private"
												/>
											) : null}
											{isSelected ? (
												<Check className="size-3.5 text-success" aria-hidden />
											) : null}
										</button>
									);
								})
							)}
						</div>
						<div className="mt-2 flex h-7 items-center justify-between gap-3 px-1">
							<span className="text-[11px] text-muted-foreground">
								{selected.length === 0
									? `${available.length} available`
									: `${selected.length} selected`}
							</span>
							<PopoverClose
								className={`inline-flex items-center rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 ${COMPACT_CLOUD_ACTION}`}
								disabled={selected.length === 0 || busy === "connect"}
								onClick={() => {
									onAdd(selected);
									setSelected([]);
								}}
							>
								Add {selected.length || ""}
							</PopoverClose>
						</div>
					</PopoverPopup>
				</Popover>
			}
		>
			<div className="divide-y divide-border/40">
				{projects.length === 0 ? (
					<CompactEmptyState
						title="No repositories included"
						description="Use + Repository to choose a personal or organization repo."
					/>
				) : (
					projects.map((project) => {
						const identity = project.repositoryIdentity
							.replace(/^github\.com\//u, "")
							.toLowerCase();
						const repository = repositories.find(
							(item) => item.nameWithOwner.toLowerCase() === identity,
						);
						return (
							<div
								key={project.projectId}
								className="flex h-10 items-center gap-2.5 px-3"
							>
								<RepositoryAvatar repository={repository} name={identity} />
								<div className="min-w-0 flex-1">
									<p className="truncate text-xs font-medium">
										{project.displayName}
									</p>
									<p className="text-[10px] text-muted-foreground">
										{project.defaultBranch} · selected for cloud image
									</p>
								</div>
								<Button
									size="icon"
									variant="ghost"
									className={`size-7 ${COMPACT_CLOUD_ACTION}`}
									aria-label={`Remove ${project.displayName}`}
									loading={busy === `remove:${project.projectId}`}
									onClick={() => onRemove(project)}
								>
									<X className="size-3.5" aria-hidden />
								</Button>
							</div>
						);
					})
				)}
				{error === null ? null : (
					<p
						role="alert"
						className="bg-destructive/10 px-3 py-2 text-xs text-destructive"
					>
						{error}
					</p>
				)}
			</div>
		</CloudSettingsGroup>
	);
}
