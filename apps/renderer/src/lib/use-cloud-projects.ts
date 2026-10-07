import { type CloudProject, CloudWorkspaceOpError } from "@zuse/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
	loadCloudProjects,
	peekCloudProjects,
} from "./cloud-workspace-session-cache.ts";
import { subscribeControlPlaneSessionCache } from "./control-plane-client.ts";
import {
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "./renderer-account.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "./renderer-workspace.ts";

const EMPTY: ReadonlyArray<CloudProject> = [];

/** Uses the existing scoped cache; never stores cloud folders in a runtime shell. */
export const useCloudProjects = (): ReadonlyArray<CloudProject> => {
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
		rendererWorkspaceSnapshot,
	);
	const account = useSyncExternalStore(
		subscribeRendererAccount,
		rendererAccountSnapshot,
		rendererAccountSnapshot,
	);
	const [result, setResult] = useState<{
		workspace: typeof workspace;
		account: typeof account;
		projects: ReadonlyArray<CloudProject>;
	} | null>(null);
	useEffect(() => {
		if (!account.subject) return;
		let cancelled = false;
		let loading = false;
		let reload = false;
		const load = () => {
			if (cancelled) return;
			if (loading) {
				reload = true;
				return;
			}
			loading = true;
			reload = false;
			let succeeded = false;
			void loadCloudProjects()
				.then(({ projects }) => {
					succeeded = true;
					if (!cancelled && !reload)
						setResult({ workspace, account, projects });
				})
				.catch((cause) => {
					if (
						!cancelled &&
						cause instanceof CloudWorkspaceOpError &&
						cause.code === "not-allowed"
					)
						// Lost access: never fall back to the cached projects.
						setResult({ workspace, account, projects: EMPTY });
					/* Retain the last scoped snapshot; settings exposes retry. */
				})
				.finally(() => {
					loading = false;
					if (reload && succeeded) load();
				});
		};
		load();
		const unsubscribe = subscribeControlPlaneSessionCache((key) => {
			if (key === "cloud-workspace:projects") load();
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [workspace, account]);
	if (result?.workspace === workspace && result.account === account)
		return result.projects;
	// Until this workspace's load settles, show its cached projects rather than
	// an empty list. The cache is keyed by account and workspace.
	return account.subject ? (peekCloudProjects()?.projects ?? EMPTY) : EMPTY;
};
