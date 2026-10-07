import {
	parseReviewFixLink,
	type ReviewFixLink,
} from "@zuse/client-runtime/review-links";
import { useEffect } from "react";
import { readReviewWebLink } from "../lib/review-web-link.ts";
import { useReviewHandoffStore } from "../store/review-handoff.ts";
import { useUiStore } from "../store/ui.ts";

/** Listen before subscribing so cold-launch links cannot race the handler. */
export function ReviewLinkAccept() {
	useEffect(() => {
		const accept = (link: ReviewFixLink) => {
			useReviewHandoffStore.getState().accept(link);
			useUiStore.getState().setView("settings");
			useUiStore.getState().setSettingsSection({ kind: "review" });
		};
		const webLink = readReviewWebLink(window.location.href);
		if (webLink) {
			accept(webLink.link);
			window.history.replaceState(
				window.history.state,
				"",
				webLink.remainingUrl,
			);
		}
		const review = window.zuse?.review;
		if (!review) return;
		const unsubscribe = review.onReviewLink((value) => {
			const link = parseReviewFixLink(value);
			if (!link) return;
			accept(link);
		});
		review.subscribeReviewLinks();
		return unsubscribe;
	}, []);
	return null;
}
