import type { LinearConnection } from "@zuse/contracts";
import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";

import { getRpcClient } from "~/lib/rpc-client.ts";
import { Button } from "../ui/button.tsx";
import { Card } from "../ui/card.tsx";
import {
	Frame,
	FrameDescription,
	FrameFooter,
	FrameHeader,
	FrameTitle,
} from "../ui/frame.tsx";
import { Spinner } from "../ui/spinner.tsx";

export function LinearIntegrationsPane() {
	const [connections, setConnections] =
		useState<ReadonlyArray<LinearConnection> | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const client = await getRpcClient();
			setConnections(
				await Effect.runPromise(client["linear.listConnections"]({})),
			);
			setError(null);
		} catch (cause) {
			setConnections([]);
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const connect = async () => {
		if (busy !== null) return;
		setBusy("connect");
		setError(null);
		try {
			const client = await getRpcClient();
			await Effect.runPromise(client["linear.connect"]({}));
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
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
			const client = await getRpcClient();
			await Effect.runPromise(
				client["linear.disconnect"]({ workspaceId: connection.workspaceId }),
			);
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	};
	const hasConnections = connections !== null && connections.length > 0;

	return (
		<Frame>
			<FrameHeader className="gap-1 px-4 py-3">
				<FrameTitle>Linear</FrameTitle>
				<FrameDescription>
					Select tickets when creating a chat. Ticket details, comments, and
					images are copied into the session workspace.
				</FrameDescription>
			</FrameHeader>

			<Card className="mx-1 overflow-hidden rounded-md">
				{error !== null && (
					<p
						role="alert"
						className="border-b border-border/60 px-4 py-3 text-xs text-destructive"
					>
						{error}
					</p>
				)}

				{connections === null ? (
					<div className="grid min-h-32 place-items-center">
						<Spinner className="size-4 text-muted-foreground" />
					</div>
				) : connections.length === 0 ? (
					<div className="flex min-h-36 flex-col items-center justify-center gap-3 p-6 text-center">
						<p className="text-sm text-muted-foreground">
							No Linear workspaces connected yet.
						</p>
						<Button
							type="button"
							onClick={() => void connect()}
							disabled={busy !== null}
							loading={busy === "connect"}
						>
							Connect workspace
						</Button>
					</div>
				) : (
					<div className="divide-y divide-border/60">
						{connections.map((connection) => (
							<div
								key={connection.workspaceId}
								className="flex items-center justify-between gap-4 p-4"
							>
								<div className="min-w-0">
									<p className="truncate text-sm font-medium">
										{connection.workspaceName}
									</p>
									<p className="truncate text-xs text-muted-foreground">
										{connection.viewerName} · {connection.viewerEmail}
									</p>
								</div>
								<Button
									type="button"
									variant="outline"
									disabled={busy !== null}
									loading={busy === connection.workspaceId}
									onClick={() => void disconnect(connection)}
								>
									Disconnect
								</Button>
							</div>
						))}
					</div>
				)}
			</Card>

			{hasConnections && (
				<FrameFooter className="flex justify-end px-4 py-3">
					<Button
						type="button"
						onClick={() => void connect()}
						disabled={busy !== null}
						loading={busy === "connect"}
					>
						Add workspace
					</Button>
				</FrameFooter>
			)}
		</Frame>
	);
}
