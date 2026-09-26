import { type ApiEnvironmentRecord, EnvironmentId } from "@zuse/contracts";
import { useEffect, useState } from "react";
import { useCloudChatCatalogStore } from "../lib/cloud-workspace-catalog.ts";
import {
	openCloudChat,
	useCloudChatsStore,
	watchCloudChatCatalog,
} from "../lib/cloud-workspaces.ts";
import { runControlPlane } from "../lib/control-plane-client.ts";
import { useEnvironmentShellResource } from "../lib/environment-shell-client-bus.ts";
import {
	connectHostedEnvironment,
	hostedAccountId,
	hostedConnectGrantEndpoint,
	listHostedEnvironments,
	registerHostedClient,
} from "../lib/hosted-connect.ts";
import {
	type HostedLaptopPreference,
	hostedLaptopPreferenceKey,
	resolveHostedLaptopPreference,
} from "../lib/hosted-laptop-preferences.ts";
import {
	hostedProjectFolderId,
	refreshHostedProjects,
	selectHostedCloudHome,
} from "../lib/hosted-workspace.ts";
import {
	registerApiEnvironment,
	setActiveEnvironment,
} from "../lib/rpc-client.ts";
import { useChatsStore } from "../store/chats.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { Button } from "./ui/button.tsx";

const preferenceKey = () => hostedLaptopPreferenceKey(hostedAccountId());
const readLaptopPreference = (): HostedLaptopPreference => {
	let stored: string | null = null;
	try {
		stored = localStorage.getItem(preferenceKey());
	} catch {
		/* Storage can be unavailable. */
	}
	return resolveHostedLaptopPreference(window.location.pathname, stored);
};

export function HostedSidebar() {
	const [preference, setPreference] = useState(readLaptopPreference);
	const [computers, setComputers] = useState<
		ReadonlyArray<ApiEnvironmentRecord>
	>([]);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [archived, setArchived] = useState(false);
	const summaries = useCloudChatCatalogStore((s) => s.summaries);
	const cloudError = useCloudChatsStore((s) => s.error);
	const cloudLoading = useCloudChatsStore((s) => s.loading);
	const selected = useChatsStore((s) => s.selectedChatId);
	useEffect(() => watchCloudChatCatalog(), []);
	useEffect(() => {
		void refreshHostedProjects().catch(() =>
			setError("Could not load cloud projects. Retry or open Settings."),
		);
	}, []);
	useEffect(() => {
		if (!preference.enabled) return;
		let active = true;
		void listHostedEnvironments().then(
			(catalog) => {
				if (active) {
					setComputers(catalog.environments);
					setCatalogError(null);
				}
			},
			() => {
				if (active) setCatalogError("Could not load computers.");
			},
		);
		return () => {
			active = false;
		};
	}, [preference.enabled]);
	const update = (next: HostedLaptopPreference) => {
		setPreference(next);
		try {
			localStorage.setItem(preferenceKey(), JSON.stringify(next));
		} catch {
			/* Session-only fallback. */
		}
		if (!next.enabled) {
			selectHostedCloudHome();
			window.history.replaceState(null, "", "/");
		}
	};
	const settings = () => {
		useUiStore.getState().setSettingsSection({ kind: "machines" });
		useUiStore.getState().setView("settings");
	};
	return (
		<aside className="flex h-full min-h-0 flex-col gap-3 p-3 text-xs">
			<div className="flex items-center justify-between">
				<span className="font-medium">Cloud chats</span>
				<Button
					className="h-7"
					variant="ghost"
					onClick={() => {
						selectHostedCloudHome();
						useUiStore.getState().setActiveMainTab("chat");
					}}
				>
					New chat
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
				{cloudLoading && summaries.length === 0 && (
					<p className="text-muted-foreground">Loading chats…</p>
				)}
				{(error || cloudError) && (
					<div role="alert">
						<p>{error || cloudError}</p>
						<Button
							className="h-7"
							variant="ghost"
							onClick={() => {
								setError(null);
								void refreshHostedProjects().catch(() =>
									setError("Could not load projects."),
								);
								void useCloudChatsStore.getState().hydrate();
							}}
						>
							Retry
						</Button>
					</div>
				)}
				{summaries
					.filter((s) =>
						archived ? s.archivedAt !== undefined : s.archivedAt === undefined,
					)
					.map((summary) => (
						<div key={summary.workspaceId} className="flex items-center gap-1">
							<button
								type="button"
								className={`min-w-0 flex-1 rounded px-2 py-1.5 text-left hover:bg-muted ${selected === summary.chatId ? "bg-muted" : ""}`}
								onClick={() => {
									selectHostedCloudHome();
									void openCloudChat(
										summary,
										hostedProjectFolderId(summary.projectId),
									).catch(() => setError("Could not open chat."));
								}}
							>
								<span className="block truncate">
									{summary.title || "New chat"}
								</span>
								<span className="block truncate text-[10px] text-muted-foreground">
									{summary.repositoryDisplayName}
								</span>
							</button>
							{!archived && (
								<button
									type="button"
									className="h-7 px-1 text-muted-foreground"
									aria-label={`Archive ${summary.title}`}
									onClick={() =>
										void useCloudChatsStore
											.getState()
											.archive(summary)
											.catch(() => setError("Could not archive chat."))
									}
								>
									×
								</button>
							)}
							{archived && (
								<button
									type="button"
									className="h-7 px-1 text-muted-foreground"
									aria-label={`Restore ${summary.title}`}
									onClick={() => {
										void runControlPlane((client) =>
											client["cloud.workspaces.unarchive"]({
												workspaceId: summary.workspaceId,
												commandId: crypto.randomUUID(),
											}),
										)
											.then(() => useCloudChatsStore.getState().hydrate())
											.catch(() => setError("Could not restore chat."));
									}}
								>
									Restore
								</button>
							)}
						</div>
					))}
				{!cloudLoading && summaries.length === 0 && (
					<p className="px-2 py-3 text-muted-foreground">
						Your cloud chats will appear here. Set up your agents and
						repositories in Settings to get started.
					</p>
				)}
				<button
					type="button"
					className="h-7 text-left text-muted-foreground"
					onClick={() => setArchived(!archived)}
				>
					{archived ? "Show active chats" : "Archived chats"}
				</button>
			</div>
			<label className="flex h-7 items-center gap-2">
				<input
					type="checkbox"
					checked={preference.enabled}
					onChange={(e) => update({ ...preference, enabled: e.target.checked })}
				/>
				Include laptop chats
			</label>
			{preference.enabled && (
				<div className="space-y-2">
					<select
						aria-label="Computer"
						className="h-7 w-full rounded bg-muted px-2"
						value={preference.environmentId ?? ""}
						onChange={(e) =>
							update({ ...preference, environmentId: e.target.value || null })
						}
					>
						<option value="">Choose a computer</option>
						{computers.map((c) => (
							<option key={c.environmentId} value={c.environmentId}>
								{c.label ?? "Computer"}
							</option>
						))}
					</select>
					{catalogError && <p role="alert">{catalogError}</p>}
					{preference.environmentId && (
						<LaptopChats
							key={preference.environmentId}
							environmentId={preference.environmentId}
						/>
					)}
				</div>
			)}
			<Button className="h-7 w-full" variant="ghost" onClick={settings}>
				Settings
			</Button>
		</aside>
	);
}
function LaptopChats({ environmentId }: { environmentId: string }) {
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let active = true;
		setReady(false);
		setError(null);
		const endpoint = async () => {
			const grant = await connectHostedEnvironment(environmentId, {
				lease: false,
			});
			return hostedConnectGrantEndpoint(grant);
		};
		void registerHostedClient()
			.then(endpoint)
			.then(
				(url) => {
					if (!active) return;
					registerApiEnvironment(environmentId, url, endpoint);
					setReady(true);
				},
				() => {
					if (active)
						setError("Computer unavailable. Cloud chats are still ready.");
				},
			);
		return () => {
			active = false;
		};
	}, [environmentId, attempt]);
	if (error)
		return (
			<div role="status">
				<p>{error}</p>
				<Button
					className="h-7"
					variant="ghost"
					onClick={() => setAttempt((a) => a + 1)}
				>
					Retry
				</Button>
			</div>
		);
	return ready ? (
		<ConnectedLaptopChats environmentId={environmentId} />
	) : (
		<p className="text-muted-foreground">Connecting…</p>
	);
}
function ConnectedLaptopChats({ environmentId }: { environmentId: string }) {
	const shell = useEnvironmentShellResource(
		EnvironmentId.make(environmentId),
		"connect",
	);
	return (
		<div className="max-h-48 overflow-auto">
			{shell.connection !== "connected" && (
				<p className="text-muted-foreground">
					Computer offline or reconnecting
				</p>
			)}
			{Object.values(shell.data?.chatsByProject ?? {})
				.flat()
				.filter((chat) => chat.archivedAt === null)
				.map((chat) => (
					<button
						key={chat.id}
						type="button"
						className="block h-7 w-full truncate rounded px-2 text-left hover:bg-muted"
						onClick={() => {
							setActiveEnvironment(environmentId);
							useEnvironmentCatalogStore.setState({
								activeEnvironmentId: environmentId,
							});
							useWorkspaceStore.setState({
								folders: shell.data?.folders ?? [],
								selectedFolderId: chat.projectId,
							});
							useChatsStore.getState().select(chat.id);
						}}
					>
						{chat.title || "New chat"}
					</button>
				))}
		</div>
	);
}
