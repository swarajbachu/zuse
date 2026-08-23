import type { CloudApiKey } from "@zuse/contracts";
import { Check, Copy, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { runControlPlane } from "../../lib/control-plane-client.ts";
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
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const result = await runControlPlane((client) =>
				client["cloud.apiKeys.list"](),
			);
			setKeys(result.keys.filter((key) => key.revokedAt === null));
			setError(null);
		} catch {
			setError("API keys could not be loaded. Try again.");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const run = async (id: string, operation: () => Promise<unknown>) => {
		if (busy !== null) return;
		setBusy(id);
		setError(null);
		try {
			await operation();
			await load();
		} catch {
			setError("That API key action could not be completed. Try again.");
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

	const revokeKey = (keyId: string) =>
		run(`revoke:${keyId}`, () =>
			runControlPlane((client) => client["cloud.apiKeys.revoke"]({ keyId })),
		);

	const copySecret = async () => {
		if (createdSecret === null) return;
		await navigator.clipboard.writeText(createdSecret);
		setCopied(true);
	};

	return (
		<CloudSettingsGroup
			title="API keys"
			description="API keys let Slack bots, scripts, and other integrations start cloud workspaces and exchange messages over the public API."
			action={
				<>
					<Input
						value={name}
						onChange={(event) => setName(event.currentTarget.value)}
						placeholder="Key name"
						className="h-7 w-32"
						aria-label="New API key name"
					/>
					<Button
						size="xs"
						className={COMPACT_CLOUD_ACTION}
						loading={busy === "create"}
						disabled={name.trim().length === 0}
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
			{keys.length === 0 && createdSecret === null ? (
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
								onClick={() => void revokeKey(key.keyId)}
							>
								Revoke
							</Button>
						}
					/>
				))
			)}
		</CloudSettingsGroup>
	);
}
