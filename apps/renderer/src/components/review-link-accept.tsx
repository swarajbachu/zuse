import { parseReviewFixLink } from "@zuse/client-runtime/review-links";
import { useEffect } from "react";
import { useReviewHandoffStore } from "../store/review-handoff.ts";
import { useUiStore } from "../store/ui.ts";

/** Listen before subscribing so cold-launch links cannot race the handler. */
export function ReviewLinkAccept() {
	useEffect(() => {
		const review = window.zuse?.review;
		if (!review) return;
		const unsubscribe = review.onReviewLink((value) => {
			const link = parseReviewFixLink(value);
			if (!link) return;
			useReviewHandoffStore.getState().accept(link);
			useUiStore.getState().setView("settings");
			useUiStore.getState().setSettingsSection({ kind: "review" });
		});
		review.subscribeReviewLinks();
		return unsubscribe;
	}, []);
	return null;
}
