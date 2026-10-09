import {
	type BillingPrepaidBalance,
	type BillingPrepaidCheckoutRequest,
	PREPAID_CREDIT_AMOUNTS,
} from "@zuse/contracts";
import "@zuse/i18n/english/settings";
import { formatNumber } from "@zuse/i18n";
import { useMessages } from "@zuse/i18n/react";
import { useId, useState } from "react";
import { Button } from "../ui/button.tsx";

export const PrepaidCredits = ({
	balance,
	busy,
	onBuy,
	onRefresh,
}: {
	readonly balance: BillingPrepaidBalance | null;
	readonly busy: boolean;
	readonly onBuy: (
		amountCents: BillingPrepaidCheckoutRequest["amountCents"],
	) => void;
	readonly onRefresh: () => void;
}) => {
	const { message } = useMessages(["settings"]);
	const amountId = useId();
	const [amount, setAmount] =
		useState<BillingPrepaidCheckoutRequest["amountCents"]>(2500);
	const money = (cents: number) =>
		formatNumber(cents / 100, { style: "currency", currency: "USD" });
	return (
		<div className="flex flex-col gap-3 px-3 py-3">
			<div className="flex items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2 text-xs font-medium">
					{message("settings:prepaid_title")}
					<span
						className="rounded-md bg-muted px-2 py-1 font-normal tabular-nums"
						aria-live="polite"
					>
						{balance
							? message("settings:prepaid_balance", {
									amount: money(balance.creditCents),
								})
							: message("settings:prepaid_loading")}
					</span>
				</div>
				<Button
					variant="ghost"
					size="xs"
					className="h-7 shrink-0 text-muted-foreground"
					disabled={busy}
					onClick={onRefresh}
				>
					{message("settings:prepaid_refresh")}
				</Button>
			</div>
			{balance && balance.debitCents > 0 && (
				<p className="text-xs text-muted-foreground">
					{message("settings:prepaid_debit", {
						amount: money(balance.debitCents),
					})}
				</p>
			)}
			<div className="flex flex-wrap items-end gap-3">
				<fieldset
					className="min-w-0 flex-1"
					disabled={!balance?.available || busy}
				>
					<legend className="mb-1.5 text-xs text-muted-foreground">
						{message("settings:prepaid_amount")}
					</legend>
					<div className="flex flex-wrap gap-1.5">
						{PREPAID_CREDIT_AMOUNTS.map((value) => (
							<label key={value} className="relative">
								<input
									type="radio"
									name={amountId}
									value={value}
									checked={amount === value}
									onChange={() => setAmount(value)}
									className="peer sr-only"
								/>
								<span className="flex h-7 cursor-pointer items-center justify-center rounded-md bg-muted/50 px-3 text-xs tabular-nums transition-colors hover:bg-muted peer-checked:bg-accent peer-checked:font-medium peer-checked:ring-1 peer-checked:ring-foreground/20 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:cursor-default peer-disabled:opacity-50">
									{money(value)}
								</span>
							</label>
						))}
					</div>
				</fieldset>
				<Button
					size="xs"
					className="h-7 shrink-0"
					disabled={!balance?.available || busy}
					loading={busy}
					onClick={() => onBuy(amount)}
				>
					{message("settings:prepaid_buy")}
				</Button>
			</div>
			<p className="text-xs leading-relaxed text-muted-foreground">
				{message("settings:prepaid_description")}
			</p>
			{balance && !balance.available && (
				<p className="text-xs text-muted-foreground">
					{message("settings:prepaid_disabled")}
				</p>
			)}
		</div>
	);
};
