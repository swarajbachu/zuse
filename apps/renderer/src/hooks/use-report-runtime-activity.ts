import type { PowerWorkloadState } from "@zuse/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useCloudChatCatalogStore } from "../lib/cloud-workspace-catalog.ts";
import { localRuntimeEnvironmentId } from "../lib/computer-awake.ts";
import { useEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { countLocalActiveAgents } from "../lib/local-agent-activity.ts";
import {
	getPowerRuntimeActivity,
	setPowerActiveAgentCount,
	subscribePowerRuntimeActivity,
} from "../lib/power-runtime-activity.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";

/** Mirror privacy-safe active workload counts to desktop-owned services. */
export function useReportRuntimeActivity(): void {
	const localEnvironmentId = useEnvironmentCatalogStore((state) =>
		localRuntimeEnvironmentId(state.entries, state.activeEnvironmentId),
	);
	const hasLocalEnvironment = useEnvironmentCatalogStore((state) =>
		state.entries.some((entry) => entry.connectionKind === "local"),
	);
	const { sessionsByProject, view } =
		useEnvironmentEntities(localEnvironmentId);
	const summaries = useCloudChatCatalogStore((state) => state.summaries);
	const runningCount = useMemo(
		() =>
			hasLocalEnvironment
				? countLocalActiveAgents({
						connection: view.connection,
						sync: view.sync,
						sessions: Object.values(sessionsByProject).flat(),
						cloudChatIds: new Set(summaries.map((summary) => summary.chatId)),
					})
				: null,
		[
			hasLocalEnvironment,
			view.connection,
			view.sync,
			sessionsByProject,
			summaries,
		],
	);

	const lastWorkload = useRef("");
	const lastRunningCount = useRef<number | null | undefined>(undefined);
	const report = useCallback(() => {
		if (runningCount !== lastRunningCount.current) {
			lastRunningCount.current = runningCount;
			setPowerActiveAgentCount(runningCount);
			if (runningCount !== null)
				window.zuse?.updates?.reportRunningCount(runningCount);
		}
		const runtimeActivity = getPowerRuntimeActivity();
		const workload: PowerWorkloadState = {
			activeAgents: runtimeActivity.activeAgents,
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
