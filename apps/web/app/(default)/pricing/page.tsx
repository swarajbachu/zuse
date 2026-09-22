import { CalendarDays, Check } from "lucide-react";
import { Button } from "@/components/button";
import { PageMasthead } from "@/components/page-masthead";
import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
	title: "Pricing: local and cloud coding agents",
	description:
		"Use Zuse locally for free during beta. Cloud Workspace costs $40/month with $35 compute included. Bring your own agent subscriptions.",
	path: "/pricing",
});
// Cloud pricing verified against infra/api/src/cloud-billing.ts.
// Public offerings are Local and Cloud Workspace; internal machine offers are not sold.
const plans = [
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
	},
];
export default function PricingPage() {
	return (
		<main>
			<PageMasthead
				eyebrow="Pricing / Bring your own agents"
				title={
					<>
						Start here.
						<br />
						<span className="heading-accent text-primary">Go further.</span>
					</>
				}
				description="Use the agents you already pay for. Choose where the work runs."
				artwork="handoff"
			/>
			<div className="grid md:grid-cols-2">
				{plans.map((plan) => (
					<section key={plan.name} className="pricing-card flex flex-col">
						<p className="editorial-label">
							{plan.download ? "On your machine" : "Cloud · Beta"}
						</p>
						<h2 className="mt-4 text-3xl">{plan.name}</h2>
						<p className="mt-6 font-mono text-4xl tracking-tight">
							{plan.price}
						</p>
						<p className="mt-2 font-mono text-xs text-muted-foreground">
							{plan.period}
						</p>
						<p className="mt-6 min-h-14 text-muted-foreground">
							{plan.summary}
						</p>
						<ul className="my-8 space-y-4 text-sm">
							{plan.features.map((feature) => (
								<li key={feature} className="flex gap-2">
									<Check size={15} className="mt-1 shrink-0 text-primary" />
									{feature}
								</li>
							))}
						</ul>
						<div className="mt-auto">
							{plan.download ? (
								<Button containerClassName="min-w-0 w-full" />
							) : (
								<Button
									text="Book a call"
									href="https://cal.com/swaraj/15min"
									icon={<CalendarDays size={16} />}
									containerClassName="min-w-0 w-full"
								/>
							)}
						</div>
					</section>
				))}
			</div>
			<section className="grid gap-10 px-5 py-16 md:grid-cols-2 md:px-16">
				<div>
					<h2 className="text-3xl">What does compute cover?</h2>
					<p className="mt-4 text-muted-foreground leading-relaxed">
						Cloud Workspace compute is infrastructure usage, not model tokens.
						Agent subscriptions and API usage are billed separately by your
						provider. Cloud prices are in USD, before applicable taxes.
					</p>
				</div>
				<div>
					<h2 className="text-3xl">Can I stay local?</h2>
					<p className="mt-4 text-muted-foreground leading-relaxed">
						Yes. Cloud is optional. Download the desktop app and connect your
						existing coding agents. Cloud access remains in beta; book a call to
						discuss availability and setup.
					</p>
				</div>
			</section>
		</main>
	);
}
