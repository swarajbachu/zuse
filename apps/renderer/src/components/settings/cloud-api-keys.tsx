import "@zuse/i18n/english/settings";
import { type CloudApiKey, CloudWorkspaceOpError } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Check, Copy, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { runControlPlane } from "../../lib/control-plane-client.ts";
import { formatError } from "../../lib/format-error.ts";
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

export const formatApiKeyError = (cause: unknown, fallback: string): string => {
	if (!(cause instanceof CloudWorkspaceOpError)) return fallback;
	if (cause.code === "not-found") {
		return "The API key endpoint or key could not be found. Refresh the list; if this persists, the server needs the API update.";
	}
	return formatError(cause);
};

export function CloudApiKeyList({
	keys,
	loading,
	hasCreatedSecret,
	busy,
	onRevoke,
}: {
	keys: ReadonlyArray<CloudApiKey> | null;
	loading: boolean;
	hasCreatedSecret: boolean;
	busy: string | null;
	onRevoke: (key: CloudApiKey) => void;
}) {
	const { message: uiMessage } = useUiMessages(["settings"]);

	if (loading) {
		return (
			<CloudSettingsRow
				title={uiMessage("settings:cloud_api_keys_loading_api_keys")}
				description={uiMessage(
					"settings:cloud_api_keys_checking_this_account_s_active_integration_keys",
				)}
			/>
		);
	}
	if (keys === null) return null;
	if (keys.length === 0 && !hasCreatedSecret) {
		return (
			<CloudSettingsRow
				title={uiMessage("settings:cloud_api_keys_no_api_keys_yet")}
				description={uiMessage(
					"settings:cloud_api_keys_create_a_key_to_call_the_public_api_keys_inherit_this_account_s_cloud_access",
				)}
				action={
					<KeyRound className="size-4 text-muted-foreground" aria-hidden />
				}
			/>
		);
	}
	return keys.map((key) => (
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
					disabled={busy !== null}
					onClick={() => onRevoke(key)}
				>
					{uiMessage("settings:cloud_api_keys_revoke")}
				</Button>
			}
		/>
	));
}

/**
 * Account-scoped API keys for the Cloud Workspaces public API (`/v1/api/**`).
 * The `zk_` secret is shown exactly once at creation; afterwards only the
 * display prefix remains.
 */
export function CloudApiKeys() {
	const { message: uiMessage } = useUiMessages(["settings"]);

	const [keys, setKeys] = useState<ReadonlyArray<CloudApiKey> | null>(null);
	const [name, setName] = useState("");
	const [createdSecret, setCreatedSecret] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [revokeTarget, setRevokeTarget] = useState<CloudApiKey | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const result = await runControlPlane((client) =>
				client["cloud.apiKeys.list"](),
			);
			setKeys(result.keys.filter((key) => key.revokedAt === null));
			setLoadError(null);
		} catch (cause) {
			setLoadError(
				formatApiKeyError(cause, "API keys could not be loaded. Try again."),
			);
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
		} catch (cause) {
			setError(
				formatApiKeyError(
					cause,
					"That API key action could not be completed. Try again.",
				),
			);
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
			setKeys((current) => [created.key, ...(current ?? [])]);
		});

	const revokeKey = async (keyId: string) => {
		const revoked = await run(`revoke:${keyId}`, async () => {
			await runControlPlane((client) =>
				client["cloud.apiKeys.revoke"]({ keyId }),
			);
			setKeys(
				(current) => current?.filter((key) => key.keyId !== keyId) ?? null,
			);
		});
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
			title={uiMessage("settings:cloud_api_keys_api_keys")}
			description={uiMessage(
				"settings:cloud_api_keys_api_keys_let_slack_bots_scripts_and_other_integrations_start_cloud_workspaces_and_exchange_messages_over_the_public_api",
			)}
			action={
				<>
					<Input
						value={name}
						maxLength={100}
						disabled={createdSecret !== null}
						onChange={(event) => setName(event.currentTarget.value)}
						placeholder={uiMessage("settings:cloud_api_keys_key_name")}
						className="h-7 w-32"
						aria-label={uiMessage("settings:cloud_api_keys_new_api_key_name")}
					/>
					<Button
						size="xs"
						className={COMPACT_CLOUD_ACTION}
						loading={busy === "create"}
						disabled={
							createdSecret !== null ||
							name.trim().length === 0 ||
							loading ||
							keys === null ||
							busy !== null
						}
						onClick={() => void createKey()}
					>
						{uiMessage("settings:cloud_api_keys_create_key")}
					</Button>
				</>
			}
		>
			{loadError === null ? null : (
				<div className="flex items-center justify-between gap-3 px-3 py-2">
					<p role="alert" className="text-xs text-destructive">
						{loadError}
					</p>
					<Button
						size="xs"
						variant="ghost"
						className={COMPACT_CLOUD_ACTION}
						loading={loading}
						disabled={busy !== null}
						onClick={() => void load()}
					>
						{uiMessage("settings:cloud_api_keys_retry")}
					</Button>
				</div>
			)}
			{error === null ? null : (
				<p role="alert" className="px-3 py-2 text-xs text-destructive">
					{error}
				</p>
			)}
			{createdSecret === null ? null : (
				<CloudSettingsRow
					title={uiMessage("settings:cloud_api_keys_copy_your_new_key_now")}
					description={uiMessage(
						"settings:cloud_api_keys_this_secret_is_shown_only_once_store_it_where_your_integration_can_read_it",
					)}
					action={
						<>
							<Input
								readOnly
								value={createdSecret}
								className="h-7 w-56 font-mono text-[11px]"
								aria-label={uiMessage(
									"settings:cloud_api_keys_new_api_key_secret",
								)}
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
								{copied
									? uiMessage("settings:cloud_api_keys_copied")
									: uiMessage("settings:cloud_api_keys_copy")}
							</Button>
							<Button
								size="xs"
								variant="ghost"
								className={COMPACT_CLOUD_ACTION}
								onClick={() => setCreatedSecret(null)}
							>
								{uiMessage("settings:cloud_api_keys_done")}
							</Button>
						</>
					}
				/>
			)}
			<CloudApiKeyList
				keys={keys}
				loading={loading}
				hasCreatedSecret={createdSecret !== null}
				busy={busy}
				onRevoke={setRevokeTarget}
			/>
			<AlertDialog
				open={revokeTarget !== null}
				onOpenChange={(open) => {
					if (!open && busy === null) setRevokeTarget(null);
				}}
			>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{uiMessage("settings:cloud_api_keys_revoke_api_key")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{uiMessage(
								"settings:cloud_api_keys_will_immediately_lose_public_api_access_this_cannot_be_undon_sentence",
								{
									value:
										revokeTarget?.name ??
										uiMessage("settings:cloud_api_keys_this_integration") ??
										"",
								},
							)}
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
							{uiMessage("settings:cloud_api_keys_cancel")}
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
							{uiMessage("settings:cloud_api_keys_revoke_key")}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</CloudSettingsGroup>
	);
}
