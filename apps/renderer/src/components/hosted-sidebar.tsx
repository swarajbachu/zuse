import { useHostedComputers } from "../hooks/use-hosted-computers.ts";
import "@zuse/i18n/english/shell";
import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/projects";
import "@zuse/i18n/english/common";
import { EnvironmentId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useEffect, useState } from "react";
import { useEnvironmentShellResource } from "../lib/environment-shell-client-bus.ts";
import {
	connectHostedEnvironment,
	hostedAccountId,
	hostedConnectGrantEndpoint,
	registerHostedClient,
} from "../lib/hosted-connect.ts";
import {
	type HostedLaptopPreference,
	hostedLaptopPreferenceKey,
	resolveHostedLaptopPreference,
	saveHostedLaptopPreference,
} from "../lib/hosted-laptop-preferences.ts";
import { selectHostedCloudHome } from "../lib/hosted-workspace.ts";
import { registerApiEnvironment } from "../lib/rpc-client.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { Button } from "./ui/button.tsx";
import { Switch } from "./ui/switch.tsx";

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

export function HostedLaptopSection() {
	const { message: uiMessage } = useUiMessages([
		"chat",
		"common",
		"projects",
		"shell",
	]);
	const [preference, setPreference] = useState(readLaptopPreference);
	const { computers, groups, failed } = useHostedComputers(preference.enabled);
	const selectedId =
		groups.find((group) =>
			group.registrations.some(
				(entry) => entry.environmentId === preference.environmentId,
			),
		)?.computer.environmentId ?? preference.environmentId;
	const catalogError = failed
		? uiMessage("shell:hosted_could_not_load_computers")
		: null;
	const update = (next: HostedLaptopPreference) => {
		setPreference(next);
		saveHostedLaptopPreference(hostedAccountId(), next);
		if (!next.enabled) {
			if (useEnvironmentCatalogStore.getState().activeEnvironmentId !== "local")
				selectHostedCloudHome();
			window.history.replaceState(null, "", "/");
		}
	};
	return (
		<div className="px-2.5 pb-2 text-xs">
			<label
				htmlFor="include-laptop-chats"
				className="flex h-7 items-center gap-2"
			>
				<Switch
					id="include-laptop-chats"
					checked={preference.enabled}
					onCheckedChange={(enabled) => update({ ...preference, enabled })}
				/>
				{uiMessage("shell:hosted_include_laptop_chats")}
			</label>
			{preference.enabled && (
				<div className="space-y-2">
					<select
						aria-label={uiMessage("shell:hosted_computer")}
						className="h-7 w-full rounded bg-muted px-2"
						value={selectedId ?? ""}
						onChange={(e) =>
							update({ ...preference, environmentId: e.target.value || null })
						}
					>
						<option value="">
							{uiMessage("shell:hosted_choose_a_computer")}
						</option>
						{computers.map((c) => (
							<option key={c.environmentId} value={c.environmentId}>
								{c.label ?? uiMessage("shell:hosted_computer")}
							</option>
						))}
					</select>
					{catalogError && <p role="alert">{catalogError}</p>}
					{selectedId && (
						<LaptopChats key={selectedId} environmentId={selectedId} />
					)}
				</div>
			)}
		</div>
	);
}

function LaptopChats({ environmentId }: { environmentId: string }) {
	const { message: uiMessage } = useUiMessages([
		"chat",
		"common",
		"projects",
		"shell",
	]);
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
						setError(
							uiMessage(
								"shell:hosted_computer_unavailable_cloud_chats_are_still_ready",
							),
						);
				},
			);
		return () => {
			active = false;
		};
	}, [environmentId, attempt, uiMessage]);
	if (error)
		return (
			<div role="status">
				<p>{error}</p>
				<Button
					className="h-7"
					variant="ghost"
					onClick={() => setAttempt((a) => a + 1)}
				>
					{uiMessage("common:retry")}
				</Button>
			</div>
		);
	return ready ? (
		<ConnectedLaptopChats environmentId={environmentId} />
	) : (
		<p className="text-muted-foreground">
			{uiMessage("chat:browser_pane_connecting")}
		</p>
	);
}
function ConnectedLaptopChats({ environmentId }: { environmentId: string }) {
	const { message: uiMessage } = useUiMessages([
		"chat",
		"common",
		"projects",
		"shell",
	]);
	const [activationError, setActivationError] = useState<string | null>(null);
	const shell = useEnvironmentShellResource(
		EnvironmentId.make(environmentId),
		"connect",
	);
	return (
		<div className="max-h-48 overflow-auto">
			{activationError && <p role="alert">{activationError}</p>}
			{shell.connection !== "connected" && (
				<p className="text-muted-foreground">
					{uiMessage("shell:hosted_computer_offline_or_reconnecting")}
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
							if (shell.data == null) return;
							setActivationError(null);
							void useEnvironmentCatalogStore
								.getState()
								.activateTransient(environmentId, shell.data, {
									folderId: chat.projectId,
									chatId: chat.id,
								})
								.catch(() =>
									setActivationError(
										uiMessage(
											"shell:hosted_computer_unavailable_cloud_chats_are_still_ready",
										),
									),
								);
						}}
					>
						{chat.title || uiMessage("projects:projects_sidebar_new_chat")}
					</button>
				))}
		</div>
	);
}
