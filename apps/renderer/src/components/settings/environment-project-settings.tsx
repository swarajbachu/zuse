import type {
	EnvironmentEntry,
	EnvironmentId,
	EnvironmentVaultSnapshot,
	FolderId,
} from "@zuse/contracts";
import { selectEnvironmentBindings } from "@zuse/utils/environment";
import { ArrowRight, Check, CloudOff, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";
import { dispatchEnvironmentLink } from "../../lib/environment-link-client-bus.ts";
import { useUiStore } from "../../store/ui.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
import { SettingsGroup, SettingsRow } from "../ui/settings-panel.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import {
	blankEnvironmentEntry,
	callEnvironmentVault,
} from "./environment-vault.ts";

const NO_PROJECT = "";

export function EnvironmentProjectSettings({
	environmentId,
	folderId,
	legacy,
	cloudLegacy,
	onRemoveLegacy,
}: {
	environmentId: EnvironmentId;
	folderId: FolderId;
	legacy: Readonly<Record<string, string>>;
	cloudLegacy: Readonly<Record<string, string>>;
	onRemoveLegacy: () => Promise<unknown>;
}) {
	const setSettingsSection = useUiStore((state) => state.setSettingsSection);
	const [snapshot, setSnapshot] = useState<EnvironmentVaultSnapshot | null>(
		null,
	);
	const [projectId, setProjectId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [target, setTarget] = useState<"local" | "cloud">("local");
	const [migrating, setMigrating] = useState(false);
	const [migrated, setMigrated] = useState(false);
	const [verifiedLegacy, setVerifiedLegacy] = useState<string | null>(null);
	const [restart, setRestart] = useState(false);
	const [offlineAt, setOfflineAt] = useState<number | null>(null);
	useEffect(() => {
		let live = true;
		setSnapshot(null);
		setProjectId(null);
		setError(null);
		setMigrated(false);
		setMigrating(false);
		setOfflineAt(null);
		void Promise.all([
			callEnvironmentVault({ action: "list" }),
			dispatchEnvironmentLink(environmentId, { folderId }),
		]).then(
			([vault, link]) => {
				if (live) {
					setSnapshot(vault.snapshot);
					setProjectId(link.projectId);
					setTarget(link.target ?? "local");
					setOfflineAt(link.offline ? (link.resolvedAt ?? null) : null);
				}
			},
			() => {
				if (live)
					setError(
						"Environment settings are unavailable. Reconnect to manage project access.",
					);
			},
		);
		return () => {
			live = false;
		};
	}, [environmentId, folderId]);
	const changeLink = async (next: string | null) => {
		setBusy(true);
		setError(null);
		try {
			const result = await dispatchEnvironmentLink(environmentId, {
				folderId,
				projectId: next,
			});
			setProjectId(result.projectId);
			setRestart(true);
		} catch {
			setError("Could not save the project link. Retry when connected.");
		} finally {
			setBusy(false);
		}
	};
	const migrate = async () => {
		if (!snapshot || !projectId) return;
		setBusy(true);
		setError(null);
		let current = snapshot;
		try {
			for (const [target, variables] of [
				["both", legacy],
				["cloud", cloudLegacy],
			] as const) {
				for (const [name, value] of Object.entries(variables)) {
					// Preserve cloud overrides by splitting matching legacy defaults by target.
					const actualTarget =
						target === "both" && name in cloudLegacy ? "local" : target;
					const existing = current.entries.find(
						(entry) =>
							entry.name === name &&
							entry.target === actualTarget &&
							entry.projectIds?.length === 1 &&
							entry.projectIds[0] === projectId,
					);
					if (existing) {
						const verified = await callEnvironmentVault({
							action: "reveal",
							id: existing.id,
						});
						if (verified.value !== value)
							throw new Error("assignment_conflict");
						current = verified.snapshot;
						setSnapshot(current);
						continue;
					}
					const result = await callEnvironmentVault({
						action: "save",
						expectedRevision: current.revision,
						entry: blankEnvironmentEntry({
							name,
							projectIds: [projectId],
							target: actualTarget,
						}),
						value,
					});
					current = result.snapshot;
					const saved = current.entries.find(
						(entry) =>
							entry.name === name &&
							entry.target === actualTarget &&
							entry.projectIds?.includes(projectId),
					);
					if (!saved) throw new Error("save_not_verified");
					const verified = await callEnvironmentVault({
						action: "reveal",
						id: saved.id,
					});
					if (verified.value !== value) throw new Error("save_not_verified");
					current = verified.snapshot;
					setSnapshot(current);
				}
			}
			setVerifiedLegacy(JSON.stringify([legacy, cloudLegacy]));
			setMigrated(true);
			setRestart(true);
		} catch {
			setError(
				"Migration stopped. Saved entries remain in the vault; repository values have not been removed. Review conflicts in Environment before retrying.",
			);
		} finally {
			setBusy(false);
		}
	};
	const removeLegacy = async () => {
		setBusy(true);
		try {
			if (verifiedLegacy !== JSON.stringify([legacy, cloudLegacy]))
				throw new Error("Repository values changed; migrate again.");
			await onRemoveLegacy();
			setMigrating(false);
		} catch {
			setError(
				"Could not remove repository values. Encrypted copies remain saved.",
			);
		} finally {
			setBusy(false);
		}
	};
	if (snapshot && !snapshot.enabled) return null;
	const effective =
		projectId && snapshot
			? selectEnvironmentBindings(snapshot.entries, projectId, target)
			: [];
	const overridden =
		snapshot?.entries.filter(
			(entry) =>
				projectId !== null &&
				!entry.excludedProjectIds.includes(projectId) &&
				(entry.target === "both" || entry.target === target) &&
				(entry.projectIds === null || entry.projectIds.includes(projectId)) &&
				effective.some(
					(selected) =>
						selected.name === entry.name && selected.id !== entry.id,
				),
		) ?? [];
	const legacyNames = [
		...new Set([...Object.keys(legacy), ...Object.keys(cloudLegacy)]),
	];
	const linkedName =
		snapshot?.projects.find((project) => project.id === projectId)?.name ??
		null;
	const footer =
		offlineAt !== null ? (
			<span className="flex items-center gap-1.5">
				<CloudOff className="size-3 shrink-0" aria-hidden />
				Offline — using the encrypted personal cache from{" "}
				{new Date(offlineAt).toLocaleString()}.
			</span>
		) : restart ? (
			<span role="status" className="flex items-center gap-1.5">
				<Info className="size-3 shrink-0" aria-hidden />
				Saved. Restart running agents and terminals to apply changes.
			</span>
		) : undefined;

	return (
		<SettingsGroup
			title="Environment"
			description="Account-managed variables and secrets injected into this repository's agents, terminals, and scripts."
			action={
				<Button
					variant="ghost"
					className="px-2 text-muted-foreground hover:text-foreground"
					onClick={() => setSettingsSection({ kind: "environment" })}
				>
					Manage
					<ArrowRight aria-hidden />
				</Button>
			}
			footer={footer}
		>
			{error ? (
				<p
					role="alert"
					className="bg-alert-error-bg px-3 py-2 text-[11px] leading-4 text-destructive"
				>
					{error}
				</p>
			) : null}
			<SettingsRow
				title="Linked project"
				description={
					target === "cloud"
						? "Cloud workspaces use the project they were created from."
						: "Link to the same project as your cloud workspace to share project-specific values."
				}
				action={
					snapshot === null ? (
						error ? null : (
							<Skeleton className="h-7 w-48 rounded-md" />
						)
					) : (
						<Select
							value={projectId ?? NO_PROJECT}
							disabled={busy || target === "cloud"}
							onValueChange={(value) => {
								if (value === null) return;
								void changeLink(value === NO_PROJECT ? null : value);
							}}
						>
							<SelectTrigger aria-label="Environment project" className="w-48">
								<SelectValue>
									{linkedName ?? (
										<span className="text-muted-foreground">
											No project linked
										</span>
									)}
								</SelectValue>
							</SelectTrigger>
							<SelectPopup>
								<SelectItem value={NO_PROJECT}>No project linked</SelectItem>
								{snapshot.projects.map((project) => (
									<SelectItem key={project.id} value={project.id}>
										{project.name}
									</SelectItem>
								))}
							</SelectPopup>
						</Select>
					)
				}
			/>
			{projectId && snapshot ? (
				<div className="flex flex-col px-3 py-2.5">
					<p className="mb-1.5 text-xs font-medium text-foreground">
						Injected {target === "cloud" ? "in cloud" : "locally"}
						<span className="ml-1.5 font-normal text-muted-foreground tabular-nums">
							{effective.length}
						</span>
					</p>
					{effective.length === 0 && overridden.length === 0 ? (
						<p className="text-[11px] text-muted-foreground">
							No variables apply to this project yet.
						</p>
					) : (
						<div className="flex flex-col">
							{effective.map((entry) => (
								<BindingRow key={entry.id} entry={entry} />
							))}
							{overridden.map((entry) => (
								<BindingRow key={entry.id} entry={entry} overridden />
							))}
						</div>
					)}
				</div>
			) : null}
			{projectId && legacyNames.length > 0 ? (
				<SettingsRow
					title="Repository variables"
					description={
						migrated
							? "Encrypted copies saved and verified. Repository files may still contain the original values."
							: `${legacyNames.length} ${legacyNames.length === 1 ? "value is" : "values are"} stored in plain text in repository settings. Move them to encrypted project secrets.`
					}
					action={
						migrated ? (
							<Button
								variant="settings"
								loading={busy}
								disabled={busy}
								onClick={() => void removeLegacy()}
							>
								Remove originals
							</Button>
						) : (
							<Button
								variant={migrating ? "ghost" : "settings"}
								disabled={busy}
								onClick={() => setMigrating(!migrating)}
							>
								{migrating ? "Cancel" : "Move to Environment"}
							</Button>
						)
					}
				>
					{migrating && !migrated ? (
						<div className="flex flex-col gap-2 rounded-md bg-muted/40 p-2.5">
							<div className="flex flex-wrap gap-1">
								{legacyNames.map((name) => (
									<span
										key={name}
										className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px]"
									>
										{name}
									</span>
								))}
							</div>
							<div className="flex items-center justify-between gap-3">
								<p className="text-[11px] leading-4 text-muted-foreground">
									Saved as secrets for this project. Cloud-only values stay
									cloud-only. Originals stay until you remove them.
								</p>
								<Button
									loading={busy}
									disabled={busy}
									onClick={() => void migrate()}
								>
									<Check aria-hidden />
									Save encrypted copies
								</Button>
							</div>
						</div>
					) : null}
				</SettingsRow>
			) : null}
		</SettingsGroup>
	);
}

function BindingRow({
	entry,
	overridden = false,
}: {
	entry: EnvironmentEntry;
	overridden?: boolean;
}) {
	return (
		<div className="flex h-7 items-center justify-between gap-3">
			<span
				className={cn(
					"min-w-0 truncate font-mono text-xs",
					overridden ? "text-muted-foreground line-through" : "text-foreground",
				)}
			>
				{entry.name}
			</span>
			<span className="flex shrink-0 items-center gap-1.5">
				{overridden ? (
					<Badge size="sm" variant="outline">
						Overridden
					</Badge>
				) : null}
				<span className="text-[11px] text-muted-foreground">
					{entry.scope === "team" ? "Team · " : ""}
					{entry.projectIds === null ? "Account default" : "Project value"}
				</span>
			</span>
		</div>
	);
}
