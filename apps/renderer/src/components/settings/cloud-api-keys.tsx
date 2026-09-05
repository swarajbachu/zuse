import type { CloudApiKey } from "@zuse/contracts";
import { Check, Copy, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { runControlPlane } from "../../lib/control-plane-client.ts";
import { copyText } from "../../lib/platform-capabilities.ts";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "../ui/alert-dialog.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import {
	CloudSettingsGroup,
	CloudSettingsRow,
	COMPACT_CLOUD_ACTION,
} from "./cloud-settings-ui.tsx";

const formatLastUsed = (lastUsedAt: number | null): string =>
	lastUsedAt === null
		? "Never used"
		: `Last used ${new Date(lastUsedAt).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			})}`;

/**
 * Account-scoped API keys for the Cloud Workspaces public API (`/v1/api/**`).
 * The `zk_` secret is shown exactly once at creation; afterwards only the
 * display prefix remains.
 */
export function CloudApiKeys() {
	const [keys, setKeys] = useState<ReadonlyArray<CloudApiKey>>([]);
	const [name, setName] = useState("");
	const [createdSecret, setCreatedSecret] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [revokeTarget, setRevokeTarget] = useState<CloudApiKey | null>(null);

	const load = useCallback(async () => {
		try {
			const result = await runControlPlane((client) =>
				client["cloud.apiKeys.list"](),
			);
			setKeys(result.keys.filter((key) => key.revokedAt === null));
			setError(null);
		} catch {
			setError("API keys could not be loaded. Try again.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const run = async (
		id: string,
		operation: () => Promise<unknown>,
	): Promise<boolean> => {
		if (busy !== null) return false;
		setBusy(id);
		setError(null);
		try {
			await operation();
			await load();
			return true;
		} catch {
			setError("That API key action could not be completed. Try again.");
			return false;
		} finally {
			setBusy(null);
		}
	};

	const createKey = () =>
		run("create", async () => {
			const trimmed = name.trim();
			if (trimmed.length === 0) throw new Error("name required");
			const created = await runControlPlane((client) =>
				client["cloud.apiKeys.create"]({ name: trimmed }),
			);
			setName("");
			setCopied(false);
			setCreatedSecret(created.secret);
		});

	const revokeKey = async (keyId: string) => {
		const revoked = await run(`revoke:${keyId}`, () =>
			runControlPlane((client) => client["cloud.apiKeys.revoke"]({ keyId })),
		);
		if (revoked) setRevokeTarget(null);
	};

	const copySecret = async () => {
		if (createdSecret === null) return;
		try {
			await copyText(createdSecret);
			setCopied(true);
			setError(null);
		} catch {
			setError("The key could not be copied. Select it and copy it manually.");
		}
	};

	return (
		<CloudSettingsGroup
			title="API keys"
			description="API keys let Slack bots, scripts, and other integrations start cloud workspaces and exchange messages over the public API."
			action={
				<>
					<Input
						value={name}
						maxLength={100}
						disabled={createdSecret !== null}
						onChange={(event) => setName(event.currentTarget.value)}
						placeholder="Key name"
						className="h-7 w-32"
						aria-label="New API key name"
					/>
					<Button
						size="xs"
						className={COMPACT_CLOUD_ACTION}
						loading={busy === "create"}
						disabled={createdSecret !== null || name.trim().length === 0}
						onClick={() => void createKey()}
					>
						Create key
					</Button>
				</>
			}
		>
			{error === null ? null : (
				<p role="alert" className="px-3 py-2 text-xs text-destructive">
					{error}
				</p>
			)}
			{createdSecret === null ? null : (
				<CloudSettingsRow
					title="Copy your new key now"
					description="This secret is shown only once. Store it where your integration can read it."
					action={
						<>
							<Input
								readOnly
								value={createdSecret}
								className="h-7 w-56 font-mono text-[11px]"
								aria-label="New API key secret"
								onFocus={(event) => event.currentTarget.select()}
							/>
							<Button
								size="xs"
								variant="ghost"
								className={COMPACT_CLOUD_ACTION}
								onClick={() => void copySecret()}
							>
								{copied ? (
									<Check className="size-3.5" aria-hidden />
								) : (
									<Copy className="size-3.5" aria-hidden />
								)}
								{copied ? "Copied" : "Copy"}
							</Button>
							<Button
								size="xs"
								variant="ghost"
								className={COMPACT_CLOUD_ACTION}
								onClick={() => setCreatedSecret(null)}
							>
								Done
							</Button>
						</>
					}
				/>
			)}
			{loading ? (
				<CloudSettingsRow
					title="Loading API keys…"
					description="Checking this account's active integration keys."
				/>
			) : keys.length === 0 && createdSecret === null ? (
				<CloudSettingsRow
					title="No API keys yet"
					description="Create a key to call the public API. Keys inherit this account's cloud access."
					action={
						<KeyRound className="size-4 text-muted-foreground" aria-hidden />
					}
				/>
			) : (
				keys.map((key) => (
					<CloudSettingsRow
						key={key.keyId}
						title={key.name}
						description={`${key.prefix}… · ${formatLastUsed(key.lastUsedAt)}`}
						action={
							<Button
								size="xs"
								variant="ghost"
								className={COMPACT_CLOUD_ACTION}
								loading={busy === `revoke:${key.keyId}`}
								onClick={() => setRevokeTarget(key)}
							>
								Revoke
							</Button>
						}
					/>
				))
			)}
			<AlertDialog
				open={revokeTarget !== null}
				onOpenChange={(open) => {
					if (!open && busy === null) setRevokeTarget(null);
				}}
			>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Revoke API key?</AlertDialogTitle>
						<AlertDialogDescription>
							{revokeTarget?.name ?? "This integration"} will immediately lose
							public API access. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							render={
								<Button
									size="xs"
									variant="ghost"
									className={COMPACT_CLOUD_ACTION}
								/>
							}
						>
							Cancel
						</AlertDialogClose>
						<Button
							size="xs"
							variant="destructive"
							className={COMPACT_CLOUD_ACTION}
							loading={
								revokeTarget !== null && busy === `revoke:${revokeTarget.keyId}`
							}
							onClick={() => {
								if (revokeTarget !== null) void revokeKey(revokeTarget.keyId);
							}}
						>
							Revoke key
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</CloudSettingsGroup>
	);
}
