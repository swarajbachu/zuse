import type { PowerWorkloadState } from "@zuse/contracts";
import { useEffect } from "react";

import {
	getPowerRuntimeActivity,
	subscribePowerRuntimeActivity,
} from "../lib/power-runtime-activity.ts";
import { useMessagesStore } from "../store/messages.ts";

/** Mirror privacy-safe active workload counts to desktop-owned services. */
export function useReportRuntimeActivity(): void {
	useEffect(() => {
		let lastWorkload = "";
		let lastRunningCount = -1;

		const countRunning = (state: {
			runningBySession: Record<string, boolean>;
		}): number => {
			let count = 0;
			for (const running of Object.values(state.runningBySession)) {
				if (running) count += 1;
			}
			return count;
		};

		const report = () => {
			const count = countRunning(useMessagesStore.getState());
			if (count !== lastRunningCount) {
				lastRunningCount = count;
				window.zuse?.updates?.reportRunningCount(count);
			}
			const runtimeActivity = getPowerRuntimeActivity();
			const workload: PowerWorkloadState = {
				activeAgents: count,
				activeTerminals: runtimeActivity.activeTerminals,
				browserSessions: runtimeActivity.browserSessions,
				activeBrowserSessions: runtimeActivity.activeBrowserSessions,
				browserRecordings: runtimeActivity.browserRecordings,
				indexing: runtimeActivity.indexing,
			};
			const serialized = JSON.stringify(workload);
			if (serialized === lastWorkload) return;
			lastWorkload = serialized;
			window.zuse?.power?.reportWorkload(workload);
		};

		report();
		const unsubscribers = [
			useMessagesStore.subscribe(report),
			subscribePowerRuntimeActivity(report),
		];

		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
			window.zuse?.power?.reportWorkload({
				activeAgents: 0,
				activeTerminals: 0,
				browserSessions: 0,
				activeBrowserSessions: 0,
				browserRecordings: 0,
				indexing: false,
			});
		};
	}, []);
}
