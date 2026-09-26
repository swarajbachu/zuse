import { useEffect, useRef } from "react";
import { formatError } from "../lib/format-error.ts";
import {
	useGitPrDetailsResource,
	useGitWorkspaceResource,
} from "../lib/git-workspace-client-bus.ts";
import { preparePrRepair } from "../lib/pr-repair.ts";
import { createPrWatchActivity } from "../lib/pr-watch-activity.ts";
import { prFailureKey } from "../lib/pr-watch-policy.ts";
import { runPrWatchRepair } from "../lib/pr-watch-repair.ts";
import { sendSessionMessage } from "../lib/session-actions.ts";
import { isSessionRuntimeBusy } from "../lib/session-runtime-state.ts";
import { useRendererSessionTimeline } from "../lib/session-timeline-hooks.ts";
import { type PrWatch, usePrWatchStore } from "../store/pr-watch.ts";
import { toastManager } from "./ui/toast.tsx";

const running = createPrWatchActivity();

function Watch({ watch }: { watch: PrWatch }) {
	const workspace = useGitWorkspaceResource(watch.ref, "connect");
	const detailsView = useGitPrDetailsResource(watch.ref, "connect");
	const timeline = useRendererSessionTimeline(
		watch.sessionId,
		"connect",
		watch.ref.environmentId,
	);
	const latestViews = useRef({ workspace, detailsView, timeline });
	latestViews.current = { workspace, detailsView, timeline };
	useEffect(() => {
		if (
			running.has(watch) ||
			workspace.sync !== "live" ||
			detailsView.sync !== "live" ||
			timeline.view.sync !== "live" ||
			workspace.connection !== "connected" ||
			detailsView.connection !== "connected" ||
			timeline.view.connection !== "connected" ||
			workspace.data?.error ||
			detailsView.data?.error
		)
			return;
		const details = detailsView.data?.details;
		if (!details || !workspace.data?.status || !timeline.projection) return;
		const current = () =>
			usePrWatchStore.getState().watches.find((item) => item.id === watch.id);
		const pause = (reason: string) => {
			const latest = current();
			if (latest && latest.generation === watch.generation)
				usePrWatchStore
					.getState()
					.save({ ...latest, enabled: false, error: reason });
		};
		if (
			details.url !== watch.url ||
			details.headBranch !== watch.branch ||
			workspace.data.status.branch !== watch.branch ||
			details.state !== "open" ||
			timeline.projection.status === "closed"
		) {
			pause("Watching stopped because the PR, branch, or chat changed.");
			return;
		}
		if (
			isSessionRuntimeBusy(timeline.runtime) ||
			timeline.projection.queue.items.length > 0
		)
			return;
		const key = prFailureKey(details);
		if (key === null || watch.handled.includes(key)) return;
		if (watch.handled.length >= watch.maxRepairs) {
			pause(
				`Paused after ${watch.maxRepairs} repairs. Review the changes before starting again.`,
			);
			return;
		}
		const release = running.begin(watch);
		void runPrWatchRepair({
			watch,
			key,
			current,
			save: usePrWatchStore.getState().save,
			prepare: () =>
				preparePrRepair(watch.ref, watch.sessionId, details, "checks"),
			canSend: () => {
				const fresh = latestViews.current;
				return (
					fresh.workspace.data?.status?.branch === watch.branch &&
					fresh.workspace.connection === "connected" &&
					fresh.workspace.sync === "live" &&
					fresh.timeline.projection?.status !== "closed" &&
					!fresh.workspace.data?.error &&
					!fresh.detailsView.data?.error &&
					fresh.timeline.view.sync === "live" &&
					fresh.timeline.view.connection === "connected" &&
					fresh.detailsView.sync === "live" &&
					fresh.detailsView.connection === "connected" &&
					!isSessionRuntimeBusy(fresh.timeline.runtime) &&
					fresh.timeline.projection?.queue.items.length === 0 &&
					fresh.detailsView.data?.details !== null &&
					fresh.detailsView.data?.details !== undefined &&
					prFailureKey(fresh.detailsView.data.details) === key
				);
			},
			send: (input, messageId) =>
				sendSessionMessage(
					{
						environmentId: watch.ref.environmentId,
						sessionId: watch.sessionId,
					},
					input,
					{ messageId },
				),
		})
			.catch((cause) => {
				try {
					pause(formatError(cause));
				} catch {
					/* Storage failure is reported below. */
				}
				toastManager.add({
					type: "error",
					title: "CI watcher paused",
					description: formatError(cause),
				});
			})
			.finally(release);
	}, [watch, workspace, detailsView, timeline]);
	return null;
}

export function PrWatchController() {
	const watches = usePrWatchStore((state) => state.watches);
	return (
		<>
			{watches
				.filter((watch) => watch.enabled)
				.map((watch) => (
					<Watch key={watch.id} watch={watch} />
				))}
		</>
	);
}
