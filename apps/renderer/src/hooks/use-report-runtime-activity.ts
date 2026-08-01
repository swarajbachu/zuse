import type { PowerWorkloadState } from "@zuse/contracts";
import { useEffect } from "react";

import {
	getPowerRuntimeActivity,
	setPowerActiveAgentCount,
	subscribePowerRuntimeActivity,
} from "../lib/power-runtime-activity.ts";
import {
	effectiveSessionRuntimeState,
	isSessionRuntimeBusy,
} from "../lib/session-runtime-state.ts";
import { useSessionRuntimeStore } from "../store/session-runtime.ts";

/** Mirror privacy-safe active workload counts to desktop-owned services. */
export function useReportRuntimeActivity(): void {
	useEffect(() => {
		let lastWorkload = "";
		let lastRunningCount = -1;

		const countRunning = (
			state: ReturnType<typeof useSessionRuntimeStore.getState>,
		): number => {
			let count = 0;
			for (const runtime of Object.values(state.bySession)) {
				if (isSessionRuntimeBusy(effectiveSessionRuntimeState(runtime))) {
					count += 1;
				}
			}
			return count;
		};

		const report = () => {
			const count = countRunning(useSessionRuntimeStore.getState());
			if (count !== lastRunningCount) {
				lastRunningCount = count;
				setPowerActiveAgentCount(count);
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
			useSessionRuntimeStore.subscribe(report),
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
