import { EnvironmentId, type PowerWorkloadState } from "@zuse/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { localRuntimeEnvironmentId } from "../lib/computer-awake.ts";
import { useEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import {
	getPowerRuntimeActivity,
	setPowerActiveAgentCount,
	subscribePowerRuntimeActivity,
} from "../lib/power-runtime-activity.ts";
import { isSessionRuntimeBusy } from "../lib/session-runtime-state.ts";
import { useRendererSessionTimelines } from "../lib/session-timeline-hooks.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";

/** Mirror privacy-safe active workload counts to desktop-owned services. */
export function useReportRuntimeActivity(): void {
	const localEnvironmentId = useEnvironmentCatalogStore((state) =>
		localRuntimeEnvironmentId(state.entries, state.activeEnvironmentId),
	);
	const { sessionsByProject } = useEnvironmentEntities(localEnvironmentId);
	const timelineRefs = useMemo(
		() =>
			Object.values(sessionsByProject)
				.flat()
				.map((session) => ({
					environmentId: EnvironmentId.make(localEnvironmentId),
					sessionId: session.id,
				})),
		[localEnvironmentId, sessionsByProject],
	);
	const timelines = useRendererSessionTimelines(timelineRefs, "cache-only");
	const runningCount = useMemo(
		() =>
			timelines.reduce(
				(count, timeline) =>
					count + (isSessionRuntimeBusy(timeline.runtime) ? 1 : 0),
				0,
			),
		[timelines],
	);
	const lastWorkload = useRef("");
	const lastRunningCount = useRef(-1);
	const report = useCallback(() => {
		if (runningCount !== lastRunningCount.current) {
			lastRunningCount.current = runningCount;
			setPowerActiveAgentCount(runningCount);
			window.zuse?.updates?.reportRunningCount(runningCount);
		}
		const runtimeActivity = getPowerRuntimeActivity();
		const workload: PowerWorkloadState = {
			activeAgents: runningCount,
			activeTerminals: runtimeActivity.activeTerminals,
			browserSessions: runtimeActivity.browserSessions,
			activeBrowserSessions: runtimeActivity.activeBrowserSessions,
			browserRecordings: runtimeActivity.browserRecordings,
			indexing: runtimeActivity.indexing,
		};
		const serialized = JSON.stringify(workload);
		if (serialized === lastWorkload.current) return;
		lastWorkload.current = serialized;
		window.zuse?.power?.reportWorkload(workload);
	}, [runningCount]);

	useEffect(() => {
		report();
		return subscribePowerRuntimeActivity(report);
	}, [report]);

	useEffect(
		() => () => {
			window.zuse?.power?.reportWorkload({
				activeAgents: 0,
				activeTerminals: 0,
				browserSessions: 0,
				activeBrowserSessions: 0,
				browserRecordings: 0,
				indexing: false,
			});
		},
		[],
	);
}
