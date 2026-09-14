import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type { EnvironmentId, Session, SessionId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { CheckListIcon } from "@zuse/icons/solid-rounded";
import { useEffect, useMemo, useState } from "react";

import {
	attachToCurrentComposer,
	fetchLatestPlan,
	fetchTranscriptMarkdown,
	saveContextFile,
} from "../../lib/context-handoff.ts";
import { selectContextSources } from "../../lib/context-sources.ts";
import { useActiveEnvironmentEntities } from "../../lib/environment-entity-hooks.ts";
import { useRendererSessionTimeline } from "../../lib/session-timeline-hooks.ts";
import { ProviderIcon } from "../provider-icons.tsx";
import { toastManager } from "../ui/toast.tsx";

/**
 * Compact tray above the composer on a fresh session. Offers one-click chips to
 * pull a sibling session's transcript or proposed plan into this one — the text
 * is written to `.context/files/` and dropped in as a composer file chip.
 * Sources are scoped to the same chat, so starting a separate chat never
 * surfaces unrelated context. Hidden once the session has a message, or when
 * there's nothing to pull from.
 */
export function ContextTray({
	sessionId,
	environmentId,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const { sessionsByProject } = useActiveEnvironmentEntities();
	const hasMessages =
		useRendererSessionTimeline(sessionId, "connect", environmentId).messages
			.length > 0;
	const [plans, setPlans] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<string | null>(null);

	const sources = useMemo(
		() => selectContextSources(sessionsByProject, sessionId),
		[sessionsByProject, sessionId, uiMessage],
	);

	useEffect(() => {
		let cancelled = false;
		void Promise.all(
			sources.map(
				async (s) =>
					[s.id, await fetchLatestPlan(environmentId, s.id)] as const,
			),
		).then((entries) => {
			if (cancelled) return;
			const next: Record<string, string> = {};
			for (const [id, plan] of entries) if (plan !== null) next[id] = plan;
			setPlans(next);
		});
		return () => {
			cancelled = true;
		};
	}, [environmentId, sources]);

	if (hasMessages || sources.length === 0) return null;

	const attach = async (
		key: string,
		source: Session,
		kind: "plan" | "transcript",
	) => {
		if (busy !== null) return;
		setBusy(key);
		try {
			const text =
				kind === "plan"
					? (plans[source.id] ?? null)
					: await fetchTranscriptMarkdown(environmentId, source.id);
			if (text === null || text.trim().length === 0) {
				toastManager.add({
					title: uiMessage("chat:context_tray_nothing_to_attach"),
					type: "error",
				});
				return;
			}
			const ref = await saveContextFile(environmentId, sessionId, text);
			if (ref === null) {
				toastManager.add({
					title: uiMessage("chat:context_tray_attach_failed"),
					type: "error",
				});
				return;
			}
			attachToCurrentComposer(ref);
			toastManager.add({
				title: kind === "plan" ? "Plan attached" : "Transcript attached",
				description: uiMessage("chat:context_tray_added_to_the_composer", {
					relPath: String(ref.relPath),
				}),
				type: "success",
			});
		} finally {
			setBusy(null);
		}
	};

	const planSources = sources.filter((s) => plans[s.id] !== undefined);
	const single = sources.length === 1;

	return (
		<div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
			<span className="text-[11px] text-muted-foreground/70">
				{uiMessage("chat:context_tray_add_context")}
			</span>
			{sources.map((s) => {
				const key = `transcript:${s.id}`;
				return (
					<Chip
						key={key}
						icon={<ProviderIcon providerId={s.providerId} className="size-3" />}
						label={
							single
								? uiMessage("chat:context_tray_transcript")
								: uiMessage("chat:context_tray_transcript_2", {
										value1: String(s.title),
									})
						}
						busy={busy === key}
						onClick={() => void attach(key, s, "transcript")}
					/>
				);
			})}
			{planSources.map((s) => {
				const key = `plan:${s.id}`;
				return (
					<Chip
						key={key}
						icon={<HugeiconsIcon icon={CheckListIcon} className="size-3" />}
						label={
							single
								? uiMessage("chat:context_tray_plan")
								: uiMessage("chat:context_tray_plan_2", {
										value1: String(s.title),
									})
						}
						busy={busy === key}
						onClick={() => void attach(key, s, "plan")}
					/>
				);
			})}
		</div>
	);
}

function Chip({
	icon,
	label,
	busy,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	busy: boolean;
	onClick: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	return (
		<button
			type="button"
			disabled={busy}
			onClick={onClick}
			title={uiMessage("chat:context_tray_attach", { label: String(label) })}
			className="inline-flex max-w-[180px] items-center gap-1 rounded-[0.375rem] border border-border/45 bg-[var(--chip-bg)] px-1.5 py-0.5 text-[11px] text-foreground/90 transition-[background-color,color] hover:text-foreground disabled:pointer-events-none disabled:opacity-50 dark:shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]"
		>
			<span className={busy ? "animate-pulse" : ""}>{icon}</span>
			<span className="min-w-0 truncate">{label}</span>
		</button>
	);
}
