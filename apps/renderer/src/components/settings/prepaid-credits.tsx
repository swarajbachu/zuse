import {
	type BillingPrepaidBalance,
	type BillingPrepaidCheckoutRequest,
	PREPAID_CREDIT_AMOUNTS,
} from "@zuse/contracts";
import "@zuse/i18n/english/settings";
import { formatNumber } from "@zuse/i18n";
import { useMessages } from "@zuse/i18n/react";
import { useState } from "react";
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
	const [amount, setAmount] =
		useState<BillingPrepaidCheckoutRequest["amountCents"]>(2500);
	const money = (cents: number) =>
		formatNumber(cents / 100, { style: "currency", currency: "USD" });
	return (
		<div className="flex flex-col gap-2 px-3 py-2">
			<div className="flex items-center justify-between gap-3">
				<div className="text-xs font-medium">
					{message("settings:prepaid_title")}
				</div>
				<div className="text-xs tabular-nums">
					{balance
						? message("settings:prepaid_balance", {
								amount: money(balance.creditCents),
							})
						: message("settings:prepaid_loading")}
				</div>
			</div>
			<p className="text-xs text-muted-foreground">
				{message("settings:prepaid_description")}
			</p>
			{balance && balance.debitCents > 0 && (
				<p className="text-xs text-muted-foreground">
					{message("settings:prepaid_debit", {
						amount: money(balance.debitCents),
					})}
				</p>
			)}
			<div className="flex items-center gap-2">
				<select
					aria-label={message("settings:prepaid_amount")}
					className="h-7 rounded-md bg-muted px-2 text-xs"
					value={amount}
					disabled={!balance?.available || busy}
					onChange={(event) => {
						const next = PREPAID_CREDIT_AMOUNTS.find(
							(value) => value === Number(event.target.value),
						);
						if (next !== undefined) setAmount(next);
					}}
				>
					{PREPAID_CREDIT_AMOUNTS.map((value) => (
						<option key={value} value={value}>
							{money(value)}
						</option>
					))}
				</select>
				<Button
					variant="ghost"
					size="xs"
					className="h-7"
					disabled={!balance?.available || busy}
					loading={busy}
					onClick={() => onBuy(amount)}
				>
					{message("settings:prepaid_buy")}
				</Button>
				<Button variant="ghost" size="xs" className="h-7" onClick={onRefresh}>
					{message("settings:prepaid_refresh")}
				</Button>
			</div>
			{balance && !balance.available && (
				<p className="text-xs text-muted-foreground">
					{message("settings:prepaid_disabled")}
				</p>
			)}
		</div>
	);
};
