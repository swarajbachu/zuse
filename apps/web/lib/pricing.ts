export interface PricingPlan {
	name: string;
	price: string;
	period: string;
	summary: string;
	features: string[];
	download: boolean;
	offer: {
		/** Numeric price in USD, as schema.org expects it. */
		amount: string;
		description: string;
		availability: "InStock" | "LimitedAvailability";
		/** Set for recurring plans; omitted for the free local plan. */
		billedMonthly?: boolean;
	};
}

export const PRICING_PLANS: PricingPlan[] = [
	{
		name: "Local",
		price: "$0",
		period: "during beta",
		summary: "Your machine. Your agents. Your workflow.",
		features: [
			"Open-source desktop app",
			"Parallel chats and Git worktrees",
			"Bring your own agent keys or subscriptions",
			"Local files, terminal, and diff review",
		],
		download: true,
		offer: {
			amount: "0",
			description:
				"Free during beta. The open-source desktop app runs on your machine with your own agent keys or subscriptions.",
			availability: "InStock",
		},
	},
	{
		name: "Cloud Workspace",
		price: "$40",
		period: "/ month · USD",
		summary: "Isolated compute for work beyond your laptop.",
		features: [
			"Cloud beta",
			"$35 of provider compute included monthly",
			"Additional compute at provider cost + 5%",
			"Configurable overage cap; $25 default",
		],
		download: false,
		offer: {
			amount: "40",
			description:
				"$40 per month in USD, including $35 of provider compute each month. Additional compute is billed at provider cost plus 5%. Cloud is in beta.",
			availability: "LimitedAvailability",
			billedMonthly: true,
		},
	},
];
