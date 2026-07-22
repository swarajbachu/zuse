import { HugeiconsIcon } from "@hugeicons/react";
import ViewIcon from "@hugeicons-pro/core-solid-rounded/ViewIcon";
import ViewOffIcon from "@hugeicons-pro/core-solid-rounded/ViewOffIcon";
import type { ProviderId } from "@zuse/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useProvidersStore } from "~/store/providers";

/**
 * Paste-an-API-key row used both in onboarding and in the per-provider
 * settings card. Saves via `useProvidersStore.setCredential` (which round-
 * trips through `agent.setCredential` → keychain).
 */
export function ApiKeyRow({ providerId }: { providerId: ProviderId }) {
	const setCredential = useProvidersStore((s) => s.setCredential);
	const [value, setValue] = useState("");
	const [reveal, setReveal] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string | null>(null);

	const onSave = async () => {
		if (value.trim().length === 0) return;
		setBusy(true);
		setStatus(null);
		try {
			await setCredential(providerId, value.trim());
			setValue("");
			setStatus("Saved.");
		} catch (err) {
			setStatus(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<Input
						type={reveal ? "text" : "password"}
						placeholder="paste API key"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						disabled={busy}
						className="h-9 rounded-md"
					/>
					<button
						type="button"
						onClick={() => setReveal((r) => !r)}
						className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
						aria-label={reveal ? "Hide key" : "Reveal key"}
						tabIndex={-1}
					>
						{reveal ? (
							<HugeiconsIcon icon={ViewOffIcon} className="size-3.5" />
						) : (
							<HugeiconsIcon icon={ViewIcon} className="size-3.5" />
						)}
					</button>
				</div>
				<Button
					size="sm"
					onClick={() => void onSave()}
					disabled={busy || value.trim().length === 0}
				>
					Save
				</Button>
			</div>
			{status !== null && (
				<p className="text-[11px] text-muted-foreground">{status}</p>
			)}
		</div>
	);
}
