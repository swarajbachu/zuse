import "@zuse/i18n/english/settings";
import {
	type CommandId,
	EnvironmentId,
	type LinearConnection,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Info } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { dispatchEnvironmentShellCommand } from "~/lib/environment-shell-client-bus.ts";
import { errorMessage } from "~/lib/error-message.ts";
import { useEnvironmentCatalogStore } from "~/store/environment-catalog.ts";
import { Button } from "../ui/button.tsx";
import { Card } from "../ui/card.tsx";
import { Frame, FrameHeader, FrameTitle } from "../ui/frame.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.tsx";

export function LinearIntegrationsPane() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const environmentId = useEnvironmentCatalogStore((state) =>
		EnvironmentId.make(state.activeEnvironmentId),
	);
	const [connections, setConnections] =
		useState<ReadonlyArray<LinearConnection> | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const { result } = await dispatchEnvironmentShellCommand<
				Record<string, never>,
				ReadonlyArray<LinearConnection>
			>({
				environmentId,
				kind: "linear.listConnections",
				commandId: crypto.randomUUID() as CommandId,
				payload: {},
			});
			setConnections(result);
			setError(null);
		} catch (cause) {
			setConnections([]);
			setError(errorMessage(cause, "Could not load connected workspaces."));
		}
	}, [environmentId]);

	useEffect(() => {
		void load();
	}, [load]);

	const connect = async () => {
		if (busy !== null) return;
		setBusy("connect");
		setError(null);
		try {
			await dispatchEnvironmentShellCommand<Record<string, never>, unknown>({
				environmentId,
				kind: "linear.connect",
				commandId: crypto.randomUUID() as CommandId,
				payload: {},
			});
			await load();
		} catch (cause) {
			setError(errorMessage(cause, "Could not connect the workspace."));
		} finally {
			setBusy(null);
		}
	};

	const disconnect = async (connection: LinearConnection) => {
		if (
			!window.confirm(
				`Disconnect ${connection.workspaceName}? Existing local ticket context will remain.`,
			)
		)
			return;
		setBusy(connection.workspaceId);
		setError(null);
		try {
			await dispatchEnvironmentShellCommand<
				{ readonly workspaceId: string },
				unknown
			>({
				environmentId,
				kind: "linear.disconnect",
				commandId: crypto.randomUUID() as CommandId,
				payload: { workspaceId: connection.workspaceId },
			});
			await load();
		} catch (cause) {
			setError(errorMessage(cause, "Could not disconnect the workspace."));
		} finally {
			setBusy(null);
		}
	};
	return (
		<Frame>
			<FrameHeader className="px-2 py-1.5">
				<FrameTitle className="text-[13px] font-medium">
					{uiMessage("settings:linear_integrations_pane_integrations")}
				</FrameTitle>
			</FrameHeader>
			<Card className="overflow-hidden">
				<div className="flex min-h-10 items-center gap-2 border-border/50 border-b px-3 py-2">
					<div className="grid size-7 shrink-0 place-items-center rounded-md border border-border/60 bg-muted/40 text-xs font-semibold">
						L
					</div>
					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						<p className="truncate text-xs font-medium">
							{uiMessage("settings:linear_integrations_pane_linear")}
						</p>
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										type="button"
										aria-label={uiMessage(
											"settings:linear_integrations_pane_about_the_linear_integration",
										)}
										className="text-muted-foreground/55 hover:text-muted-foreground"
									>
										<Info className="size-3.5" />
									</button>
								}
							/>
							<TooltipPopup className="max-w-64">
								{uiMessage(
									"settings:linear_integrations_pane_select_tickets_when_creating_a_chat_ticket_details_comments_and_images",
								)}
							</TooltipPopup>
						</Tooltip>
					</div>
					<Button
						type="button"
						size="sm"
						onClick={() => void connect()}
						disabled={busy !== null}
						loading={busy === "connect"}
					>
						{connections !== null && connections.length > 0
							? uiMessage("settings:linear_integrations_pane_add_workspace")
							: uiMessage("common:connect")}
					</Button>
				</div>
				{error !== null && (
					<p
						role="alert"
						className="border-border/60 border-b px-3 py-2 text-[11px] text-destructive"
					>
						{error}
					</p>
				)}

				{connections === null ? (
					<div className="grid min-h-16 place-items-center">
						<Spinner className="size-4 text-muted-foreground" />
					</div>
				) : connections.length === 0 ? (
					<div className="px-3 py-4 text-center">
						<p className="text-[11px] text-muted-foreground">
							{uiMessage(
								"settings:linear_integrations_pane_no_linear_workspaces_connected_yet",
							)}
						</p>
					</div>
				) : (
					<div className="divide-y divide-border/60">
						{connections.map((connection) => (
							<div
								key={connection.workspaceId}
								className="flex items-center justify-between gap-3 px-3 py-2.5"
							>
								<div className="min-w-0">
									<p className="truncate text-xs font-medium">
										{connection.workspaceName}
									</p>
									<p className="truncate text-[11px] text-muted-foreground">
										{connection.viewerName} · {connection.viewerEmail}
									</p>
									{connection.status === "reauthRequired" && (
										<p className="mt-1 text-xs text-destructive">
											{uiMessage(
												"settings:linear_integrations_pane_authorization_expired_reconnect_this_workspace",
											)}
										</p>
									)}
								</div>
								<div className="flex items-center gap-2">
									{connection.status === "reauthRequired" && (
										<Button
											type="button"
											size="sm"
											disabled={busy !== null}
											loading={busy === "connect"}
											onClick={() => void connect()}
										>
											{uiMessage("settings:linear_integrations_pane_reconnect")}
										</Button>
									)}
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={busy !== null}
										loading={busy === connection.workspaceId}
										onClick={() => void disconnect(connection)}
									>
										{uiMessage("common:disconnect")}
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
			</Card>
		</Frame>
	);
}
