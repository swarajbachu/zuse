import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { GitPrCheckRun } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import {
	ArrowUpRight01Icon,
	Cancel01Icon,
	MinusSignIcon,
	Tick02Icon,
} from "@zuse/icons/solid-rounded";
import type { ReactNode } from "react";
import { isHttpUrl, openHttpLink as openExternal } from "../lib/http-links.ts";
import { type CheckKind, checkKind } from "../lib/pr-checks.ts";
import { Spinner } from "./ui/spinner.tsx";

const rank: Record<CheckKind, number> = {
	failure: 0,
	pending: 1,
	success: 2,
	neutral: 3,
};

export function PrChecksPreview({
	checks,
	loading,
	action,
}: {
	checks: readonly GitPrCheckRun[] | null;
	loading: boolean;
	action?: ReactNode;
}) {
	const { message } = useMessages(["common", "projects", "chat"]);
	const ordered = [...(checks ?? [])].sort(
		(a, b) => rank[checkKind(a)] - rank[checkKind(b)],
	);
	return (
		<div className="min-w-0 flex-1">
			<div className="flex h-8 items-center gap-1 border-b border-border/50 px-2 pb-1">
				<span className="flex-1 text-[11px] font-medium text-muted-foreground">
					{message("projects:pr_pane_checks")}
					{checks !== null && (
						<span className="ml-1 tabular-nums">{checks.length}</span>
					)}
				</span>
				{loading && <Spinner className="size-3 text-muted-foreground" />}
				{action}
			</div>
			{ordered.length === 0 ? (
				<div role="status" className="px-2 py-3 text-xs text-muted-foreground">
					{checks === null
						? message(
								loading
									? "chat:environment_summary_loading_checks"
									: "chat:environment_summary_check_details_unavailable",
							)
						: message("projects:pr_pane_no_checks_configured")}
				</div>
			) : (
				<ul className="max-h-60 overflow-y-auto overscroll-contain py-1">
					{ordered.map((check, index) => {
						const kind = checkKind(check);
						const icon =
							kind === "failure"
								? Cancel01Icon
								: kind === "success"
									? Tick02Icon
									: MinusSignIcon;
						const tone =
							kind === "failure"
								? "text-[var(--accent-red)]"
								: kind === "pending"
									? "text-[var(--accent-amber)]"
									: kind === "success"
										? "text-[var(--accent-green)]"
										: "text-muted-foreground";
						return (
							<li key={`${check.name}:${index}`}>
								<button
									type="button"
									disabled={!isHttpUrl(check.url)}
									title={check.name}
									aria-label={`${check.name}: ${(check.conclusion ?? check.status).replaceAll("_", " ")}`}
									onClick={() => {
										if (isHttpUrl(check.url)) void openExternal(check.url);
									}}
									className="group flex h-6 w-full items-center gap-2 rounded-md px-2 text-left text-xs outline-none hover:bg-muted/60 focus-visible:bg-muted/60 disabled:hover:bg-transparent"
								>
									{kind === "pending" ? (
										<Spinner className={`size-3.5 shrink-0 ${tone}`} />
									) : (
										<HugeiconsIcon
											icon={icon}
											className={`size-3.5 shrink-0 ${tone}`}
										/>
									)}
									<span className="min-w-0 flex-1 truncate">{check.name}</span>
									<HugeiconsIcon
										icon={ArrowUpRight01Icon}
										className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:invisible"
									/>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
