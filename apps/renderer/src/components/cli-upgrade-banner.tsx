import { HugeiconsIcon } from "@hugeicons/react";
import CircleArrowUp01Icon from "@hugeicons-pro/core-solid-rounded/CircleArrowUp01Icon";
import Copy01Icon from "@hugeicons-pro/core-solid-rounded/Copy01Icon";
import LinkSquare01Icon from "@hugeicons-pro/core-solid-rounded/LinkSquare01Icon";
import Tick01Icon from "@hugeicons-pro/core-solid-rounded/Tick01Icon";
import type { ProviderId } from "@zuse/contracts";
import { RefreshCw as RefreshIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { openExternal } from "~/lib/platform-capabilities";
import { useProvidersStore } from "../store/providers.ts";

// Per-provider docs URL surfaced as "Upgrade guide" — opens in the user's
// system browser via the Electron bridge.
const UPGRADE_DOCS_URL: Record<ProviderId, string> = {
	claude: "https://docs.claude.com/en/docs/claude-code/setup",
	codex: "https://github.com/openai/codex#installation",
	grok: "https://docs.x.ai/build/overview",
	cursor: "https://cursor.com/cli",
	gemini: "https://github.com/google-gemini/gemini-cli#installation",
	opencode: "https://opencode.ai/docs/install/",
};

/**
 * Inline upgrade card that sits above `ChatComposer` whenever the active
 * session's provider has `cliVersionStatus === "outdated"`. Lets the user
 * see the upgrade path without leaving the session — the chat header chip
 * still allows switching model or provider mid-session, which is the other
 * escape hatch when (e.g.) codex is stale but claude is ready.
 *
 * Renders nothing for `ok` / `unknown` so it's safe to mount unconditionally
 * inside the chat shell.
 */
export function CliUpgradeBanner({
	providerId,
	constrain = true,
}: {
	providerId: ProviderId;
	constrain?: boolean;
}) {
	const availability = useProvidersStore((s) => s.availability);
	const refresh = useProvidersStore((s) => s.refresh);
	const refreshing = useProvidersStore((s) => s.loading);
	const [copied, setCopied] = useState(false);
	const [dismissed, setDismissed] = useState(false);

	const row = availability.find((a) => a.providerId === providerId);
	if (row === undefined || row.cliVersionStatus !== "outdated" || dismissed) {
		return null;
	}

	const command = row.cliUpgradeCommand ?? null;
	const docsUrl = UPGRADE_DOCS_URL[providerId];

	const onCopy = async () => {
		if (command === null) return;
		try {
			await navigator.clipboard.writeText(command);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard can fail under strict CSP — the user still sees the
			// command in the box and can select it by hand. Silent fail is
			// friendlier than a toast about a permission edge case.
		}
	};

	const onOpenDocs = () => {
		void openExternal(docsUrl);
	};

	return (
		<div
			className={
				constrain
					? "mx-3 mb-2 mt-1 flex flex-col gap-2 rounded-2xl bg-alert-warning-bg p-3"
					: "mb-2 mt-1 flex flex-col gap-2 rounded-2xl bg-alert-warning-bg p-3"
			}
		>
			<div className="flex items-start gap-2.5">
				<span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-warning">
					<HugeiconsIcon icon={CircleArrowUp01Icon} className="size-3.5" />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="text-[12.5px] font-medium text-foreground">
						Update {row.displayName} to keep using it
					</span>
					<span className="text-[11.5px] leading-snug text-muted-foreground">
						You have{" "}
						<code className="text-foreground/80">
							{row.cliVersion ?? "an unknown version"}
						</code>
						{row.cliVersionMinRequired !== undefined &&
							` — Zuse Alpha needs ${row.cliVersionMinRequired} or newer.`}
						{
							" Sending in this session will fail until you upgrade; start a new session with a different provider to keep working in the meantime."
						}
					</span>
				</div>
				<button
					type="button"
					onClick={() => setDismissed(true)}
					className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
					aria-label="Dismiss upgrade banner"
				>
					Hide
				</button>
			</div>

			{command !== null && (
				<div className="flex items-center justify-between gap-3 rounded-lg bg-background/40 px-3 py-1.5 font-mono text-[11.5px]">
					<code className="truncate text-foreground/90">$ {command}</code>
					<Button
						size="xs"
						variant="ghost"
						onClick={() => void onCopy()}
						className="h-6 shrink-0 gap-1 rounded-full px-2.5 text-[11px]"
					>
						{copied ? (
							<>
								<HugeiconsIcon icon={Tick01Icon} className="size-3" /> Copied
							</>
						) : (
							<>
								<HugeiconsIcon icon={Copy01Icon} className="size-3" /> Copy
							</>
						)}
					</Button>
				</div>
			)}

			<div className="flex items-center justify-end gap-1.5">
				<Button
					size="xs"
					variant="ghost"
					onClick={onOpenDocs}
					className="gap-1.5 rounded-full text-[11px] text-muted-foreground"
				>
					<HugeiconsIcon icon={LinkSquare01Icon} className="size-3" />
					Upgrade guide
				</Button>
				<Button
					size="xs"
					variant="ghost"
					onClick={() => void refresh()}
					disabled={refreshing}
					className="gap-1.5 rounded-full text-[11px] text-muted-foreground"
				>
					<RefreshIcon
						className={`size-3 ${refreshing ? "animate-spin" : ""}`}
					/>
					Recheck
				</Button>
			</div>
		</div>
	);
}
