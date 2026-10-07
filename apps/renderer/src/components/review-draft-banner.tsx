import "@zuse/i18n/english/settings";
import { useMessages } from "@zuse/i18n/react";
import { useEffect, useRef, useState } from "react";
import { runCloudControl } from "../lib/control-plane-client.ts";
import { reviewFixPrompt } from "../lib/review-presentation.ts";
import { useComposerDraftsStore } from "../store/composer-drafts.ts";
import { useReviewDraftStore } from "../store/review-draft.ts";
import { Button } from "./ui/button.tsx";

export function ReviewDraftBanner({
	draftKey,
	repositoryIdentity,
}: {
	draftKey: string;
	repositoryIdentity: string | null;
}) {
	const { message: m } = useMessages(["settings"]);
	const pending = useReviewDraftStore((s) => s.pending);
	const [busy, setBusy] = useState(false);
	const inFlight = useRef(false);
	const [notice, setNotice] = useState<string | null>(null);
	const currentTarget = useRef({ draftKey, repositoryIdentity });
	currentTarget.current = { draftKey, repositoryIdentity };
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	if (pending === null) return null;
	const attach = async () => {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setNotice(null);
		const target = currentTarget.current;
		try {
			const context = await runCloudControl((client) =>
				client["review.fixContext"]({ id: pending.runId }),
			);
			if (
				!mounted.current ||
				target.draftKey !== currentTarget.current.draftKey ||
				target.repositoryIdentity !==
					currentTarget.current.repositoryIdentity ||
				useReviewDraftStore.getState().pending !== pending
			)
				return;
			if (
				target.repositoryIdentity?.toLowerCase() !==
				`github.com/${context.repositoryFullName}`.toLowerCase()
			) {
				setNotice(
					m("settings:review_choose_repository", {
						repository: context.repositoryFullName,
					}),
				);
				return;
			}
			useComposerDraftsStore.getState().addContext(draftKey, {
				sourceKey: `review:${pending.runId}:${pending.findingIds.join(",")}`,
				label: `Zuse Review · ${context.repositoryFullName} #${context.pullNumber}`,
				text: reviewFixPrompt(context, pending.findingIds),
			});
			useReviewDraftStore.getState().clear();
		} catch {
			if (mounted.current) setNotice(m("settings:review_fix_unavailable"));
		} finally {
			inFlight.current = false;
			if (mounted.current) setBusy(false);
		}
	};
	return (
		<div className="mb-3 rounded-md bg-muted/40 px-3 py-2 text-xs">
			<p>{m("settings:review_draft_instructions")}</p>
			{notice && (
				<p role="status" className="mt-1">
					{notice}
				</p>
			)}
			<div className="mt-2 flex gap-2">
				<Button
					className="h-7"
					disabled={busy || repositoryIdentity === null}
					onClick={() => void attach()}
				>
					{m("settings:review_attach")}
				</Button>
				<Button
					className="h-7"
					variant="ghost"
					onClick={() => useReviewDraftStore.getState().clear()}
				>
					{m("settings:review_clear")}
				</Button>
			</div>
		</div>
	);
}
