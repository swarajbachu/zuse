import type { AuthTokenSummary } from "@zuse/contracts";
import { Monitor, Smartphone } from "lucide-react";
import { useCallback, useState } from "react";

import {
	accessDeviceKind,
	deviceAccessCopy,
	groupPairedDeviceTokens,
} from "../../../lib/paired-phones.ts";
import { dispatchLocalDeviceCommand } from "../../../lib/local-device-client-bus.ts";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "../../ui/alert-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import { Card } from "../../ui/card.tsx";
import { Frame } from "../../ui/frame.tsx";
import { showError } from "./access-errors.ts";
import { RemoteAccessSectionHeader } from "./section-header.tsx";

/** Paired devices list plus the consolidated legacy-credentials row. */
export function ConnectedDevicesCard({
	tokens,
	onTokens,
	refresh,
}: {
	readonly tokens: ReadonlyArray<AuthTokenSummary>;
	readonly onTokens: (tokens: ReadonlyArray<AuthTokenSummary>) => void;
	readonly refresh: () => Promise<void>;
}) {
	const [legacyRevokeOpen, setLegacyRevokeOpen] = useState(false);
	const [legacyRevokeBusy, setLegacyRevokeBusy] = useState(false);

	const { identifiedDevices, legacyCredentials } =
		groupPairedDeviceTokens(tokens);
	const hasActiveTokens =
		identifiedDevices.length > 0 || legacyCredentials.length > 0;

	const revokeToken = useCallback(
		async (token: AuthTokenSummary) => {
			try {
				await dispatchLocalDeviceCommand("pairing.revokeToken", {
					tokenId: token.id,
				});
				onTokens(
					tokens.map((item) =>
						item.id === token.id ? { ...item, revokedAt: new Date() } : item,
					),
				);
			} catch (cause) {
				showError("Could not revoke device access", cause);
			}
		},
		[onTokens, tokens],
	);

	const revokeTokens = useCallback(
		async (items: ReadonlyArray<AuthTokenSummary>) => {
			if (legacyRevokeBusy) return;
			setLegacyRevokeBusy(true);
			try {
				const results = await Promise.allSettled(
					items.map((token) =>
						dispatchLocalDeviceCommand("pairing.revokeToken", {
							tokenId: token.id,
						}),
					),
				);
				await refresh();
				if (results.some((result) => result.status === "rejected")) {
					throw new Error("Some credentials could not be revoked. Try again.");
				}
				setLegacyRevokeOpen(false);
			} catch (cause) {
				showError("Could not revoke older device access", cause);
			} finally {
				setLegacyRevokeBusy(false);
			}
		},
		[legacyRevokeBusy, refresh],
	);

	return (
		<Frame>
			<RemoteAccessSectionHeader
				title={deviceAccessCopy.pairedTitle}
				tooltip="Devices authorized to open this computer’s projects and chats."
			/>
			<Card className="overflow-hidden">
				{hasActiveTokens ? (
					<div className="flex flex-col divide-y divide-border/40">
						{identifiedDevices.map((token) => (
							<div
								key={token.id}
								className="flex min-h-11 items-center gap-2.5 px-3 py-2"
							>
								{accessDeviceKind(token) === "browser" ? (
									<Monitor
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden
									/>
								) : (
									<Smartphone
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden
									/>
								)}
								<div className="min-w-0 flex-1">
									<p className="truncate text-xs font-medium">
										{token.label ??
											(accessDeviceKind(token) === "browser"
												? "Web browser"
												: "Mobile device")}
									</p>
									<p className="text-[11px] text-muted-foreground">
										{token.lastUsedAt
											? `Last connected ${token.lastUsedAt.toLocaleString()}`
											: "Not connected yet"}
									</p>
								</div>
								<Button
									size="xs"
									variant="destructive-outline"
									onClick={() => void revokeToken(token)}
								>
									Revoke
								</Button>
							</div>
						))}
						{legacyCredentials.length > 0 && (
							<div className="flex min-h-11 items-center gap-2.5 px-3 py-2">
								<Smartphone
									className="size-4 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								<div className="min-w-0 flex-1">
									<p className="truncate text-xs font-medium">
										Older device access
									</p>
									<p className="text-[11px] text-muted-foreground">
										{legacyCredentials.length} access credential
										{legacyCredentials.length === 1 ? "" : "s"} from an earlier
										version
									</p>
								</div>
								<Button
									size="xs"
									variant="destructive-outline"
									onClick={() => setLegacyRevokeOpen(true)}
								>
									Revoke all
								</Button>
							</div>
						)}
					</div>
				) : (
					<p className="px-3 py-4 text-[11px] text-muted-foreground">
						No other devices are connected yet.
					</p>
				)}
			</Card>

			<AlertDialog
				open={legacyRevokeOpen}
				onOpenChange={(open) => {
					if (!legacyRevokeBusy) setLegacyRevokeOpen(open);
				}}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>Revoke older device access?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes {legacyCredentials.length} older access credential
							{legacyCredentials.length === 1 ? "" : "s"}. Any browser or device
							still using them will need to connect again.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							render={<Button variant="outline" disabled={legacyRevokeBusy} />}
						>
							Cancel
						</AlertDialogClose>
						<Button
							variant="destructive"
							disabled={legacyRevokeBusy}
							onClick={() => void revokeTokens(legacyCredentials)}
						>
							{legacyRevokeBusy ? "Revoking…" : "Revoke access"}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</Frame>
	);
}
