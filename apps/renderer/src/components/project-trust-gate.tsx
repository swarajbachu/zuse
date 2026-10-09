import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { EnvironmentId, FolderId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Alert02Icon } from "@zuse/icons/bulk-rounded";
import { useEffect, useState } from "react";

import { isCloudProjectFolder } from "../lib/cloud-project-folders.ts";
import {
	repositorySettingsKey,
	useRepositorySettingsStore,
} from "../store/repository-settings.ts";
import { Button } from "./ui/button.tsx";

/**
 * "Keep untrusted" hides the banner for this renderer session only — the
 * server's trust flag is what actually persists, so the prompt returns on
 * next launch while the project stays gated. Granting trust clears the
 * banner on its own because `gatedConfig` comes back null.
 */
const dismissedProjects = new Set<string>();

/**
 * Non-blocking trust banner for a project whose repository ships Zuse
 * configuration (`.zuse/settings.*` scripts/env/overrides, `.mcp.json`
 * servers). The workspace loads normally; the server holds the config
 * back until the user grants trust once. Renders nothing for trusted
 * projects and for untrusted projects that ship nothing worth gating.
 */
export function ProjectTrustGate({
	environmentId,
	projectId,
}: {
	readonly environmentId: EnvironmentId;
	readonly projectId: FolderId;
}) {
	const { message: uiMessage } = useUiMessages(["projects"]);

	const key = repositorySettingsKey(environmentId, projectId);
	const settings = useRepositorySettingsStore((s) => s.byProject[key] ?? null);
	const refresh = useRepositorySettingsStore((s) => s.refresh);
	const update = useRepositorySettingsStore((s) => s.update);
	const [dismissed, setDismissed] = useState(() => dismissedProjects.has(key));
	const [granting, setGranting] = useState(false);

	useEffect(() => {
		if (settings === null && !isCloudProjectFolder(projectId))
			void refresh(environmentId, projectId);
	}, [environmentId, projectId, settings, refresh]);

	if (isCloudProjectFolder(projectId) || dismissed) return null;
	const gated = settings?.gatedConfig ?? null;
	if (gated === null) return null;

	const items: string[] = [];
	if (gated.setupScript !== null)
		items.push(
			uiMessage("projects:project_trust_gate_setup_script", {
				value: gated.setupScript,
			}),
		);
	if (gated.runScript !== null)
		items.push(
			uiMessage("projects:project_trust_gate_run_script", {
				value: gated.runScript,
			}),
		);
	if (gated.archiveCleanupScript !== null)
		items.push(
			uiMessage("projects:project_trust_gate_archive_script", {
				value: gated.archiveCleanupScript,
			}),
		);
	if (gated.autoRunAfterSetup)
		items.push(uiMessage("projects:project_trust_gate_auto_run"));
	if (gated.environmentVariableNames.length > 0)
		items.push(
			uiMessage("projects:project_trust_gate_env_vars", {
				value: gated.environmentVariableNames.join(", "),
			}),
		);
	if (gated.mcpServerNames.length > 0)
		items.push(
			uiMessage("projects:project_trust_gate_mcp_servers", {
				value: gated.mcpServerNames.join(", "),
			}),
		);
	if (gated.otherOverrides)
		items.push(uiMessage("projects:project_trust_gate_other_overrides"));

	const keepUntrusted = () => {
		dismissedProjects.add(key);
		setDismissed(true);
	};
	const trust = async () => {
		setGranting(true);
		try {
			await update(environmentId, projectId, { trusted: true });
		} finally {
			setGranting(false);
		}
	};

	return (
		<div
			role="status"
			className="mx-3 mt-2 flex shrink-0 items-start gap-2.5 rounded-lg bg-alert-warning-bg p-3"
		>
			<span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-warning">
				<HugeiconsIcon icon={Alert02Icon} className="size-3.5" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-[12.5px] font-medium text-foreground">
					{uiMessage("projects:project_trust_gate_title")}
				</span>
				<span className="text-[11.5px] leading-snug text-muted-foreground">
					{items.join(" · ")}
				</span>
				<span className="text-[11.5px] leading-snug text-muted-foreground">
					{uiMessage("projects:project_trust_gate_footer")}
				</span>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<Button
					size="xs"
					variant="ghost"
					className="h-7 rounded-full text-[11px] text-muted-foreground"
					onClick={keepUntrusted}
				>
					{uiMessage("projects:project_trust_gate_dismiss")}
				</Button>
				<Button
					size="xs"
					className="h-7 rounded-full text-[11px]"
					loading={granting}
					onClick={() => void trust()}
				>
					{uiMessage("projects:project_trust_gate_trust")}
				</Button>
			</div>
		</div>
	);
}
