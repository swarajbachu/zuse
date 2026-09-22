import Link from "next/link";
import {
	LegalPageShell,
	LegalSectionNav,
} from "@/components/legal/legal-page-shell";
import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
	title: "Subprocessors & third-party services",
	description:
		"The service providers and user-selected third-party services that may process information when you use Zuse.",
	path: "/subprocessors",
});

const zuseProviders = [
	{
		name: "WorkOS",
		role: "Account authentication",
		data: "Account identifiers, verified email and profile details returned by the sign-in flow, and session or access-token material needed to authenticate requests.",
		applies:
			"Signed-in desktop, mobile, remote, and Cloud Workspace features. Not required for the ordinary local desktop workspace.",
		choice:
			"Do not create or use an account for local-only work; sign out when you do not need account features.",
	},
	{
		name: "PostHog",
		role: "Product analytics",
		data: "A pseudonymous installation or account-derived analytics identity; approved event names and limited properties such as screens, feature use, normalized provider/model choices, aggregate usage, performance, and sanitized reliability outcomes.",
		applies:
			"Optional desktop and mobile analytics. Analytics can run while signed out.",
		choice: "Turn off “Share usage analytics” in desktop or mobile Settings.",
	},
	{
		name: "Cloudflare",
		role: "API, edge routing, storage, and database connectivity",
		data: "Account and workspace lifecycle metadata, connection tickets, encrypted command envelopes and results, and encrypted transcript checkpoints. Cloudflare also handles network and routing information needed for requests. The API uses Workers, Durable Objects, R2, and Hyperdrive; managed tunnels are an optional remote-connectivity path.",
		applies:
			"Signed-in API, remote connectivity, and Cloud Workspace features. Local desktop data does not pass through this service just to run a local workspace.",
		choice:
			"Use local, LAN, SSH, or another user-managed environment instead of Cloud Workspace or managed remote connectivity.",
	},
	{
		name: "E2B",
		role: "Isolated Cloud Workspace compute and paused workspace storage",
		data: "Cloud Workspace repository contents, files, terminals, provider processes, and runtime state needed to execute an accepted task. Zuse sends scoped runtime credentials and receives lifecycle signals and usage information.",
		applies:
			"The Cloud Workspace public beta, when you create or resume a Cloud Workspace. It is not used for local, paired, SSH, or user-managed remote environments.",
		choice:
			"Do not create a Cloud Workspace; use a local or user-managed environment.",
	},
	{
		name: "Polar",
		role: "Cloud Workspace billing and usage metering",
		data: "Billing account and subscription identifiers, selected product, payment status, and usage totals needed for checkout, entitlement, and overage reconciliation. Payment details are handled in Polar's checkout flow rather than entered into the Zuse app.",
		applies:
			"Signed-in users who use a paid or metered Cloud Workspace offer. Checkout and billing enforcement are rollout-controlled and may be disabled for a cohort.",
		choice:
			"Do not start a paid Cloud Workspace offer. Manage billing through the provider's checkout or customer-portal flow when it is presented.",
	},
	{
		name: "Expo push service",
		role: "Mobile push-notification delivery",
		data: "A device push token and a small notification payload, such as an activity kind, target, and optional title, so the mobile app can alert you.",
		applies:
			"Mobile only, after you sign in, register a device, and grant notification permission. It is not used for desktop notifications.",
		choice:
			"Decline or revoke notification permission, or turn notifications off in mobile and device settings.",
	},
	{
		name: "GitHub",
		role: "Cloud Workspace repository connection",
		data: "When you install the Zuse GitHub App, GitHub account and installation metadata, repository selection, repository metadata, and short-lived scoped installation credentials. A selected repository's contents may then be copied into the E2B workspace you request.",
		applies:
			"Only for the optional Cloud Workspace GitHub connection. Zuse does not need GitHub for local repositories or other remote environments.",
		choice:
			"Do not install the Zuse GitHub App, select only repositories you are authorized to use, and revoke the installation in GitHub when finished.",
	},
	{
		name: "Website hosting and waitlist destination",
		role: "Public-site delivery and optional signup handling",
		data: "Network request information needed to deliver the site. If you submit the waitlist form, the deployment-configured destination receives the email address, submission time, and form source.",
		applies:
			"Website visitors and people who choose to submit the public waitlist form. The exact deployment provider is configuration-dependent and is not identified in this repository.",
		choice:
			"You can browse without joining the waitlist. Do not submit the form if you do not want its configured destination to receive the entered email address.",
	},
] as const;

const selectedServices = [
	{
		name: "Model and coding-agent providers",
		role: "The provider you choose runs the requested model or coding agent",
		data: "Prompts, responses, attachments, files, commands, credentials, and other content you deliberately make available to that provider, plus provider account and usage data under its own controls.",
		applies:
			"Any local, remote, or Cloud Workspace session where you connect or select a provider. Supported providers and models vary by release and configuration.",
		choice:
			"Choose whether to connect a provider, which model to use, and what content or permissions to provide. Review that provider's terms and privacy notice.",
	},
	{
		name: "Source-control, package, browser, and other integrations",
		role: "Independent services you direct Zuse or an agent to use",
		data: "The requests, repository or package data, browser data, credentials, and outputs involved in the integration you enable. Zuse does not control the service's processing, retention, or availability.",
		applies:
			"Only when you connect or use the relevant service. A local workspace has no automatic upload to these services.",
		choice:
			"Connect only services you trust and are authorized to use; revoke credentials and integrations when you no longer need them.",
	},
] as const;

type ProviderCardData = {
	readonly name: string;
	readonly role: string;
	readonly data: string;
	readonly applies: string;
	readonly choice: string;
};

function ProviderCard({ name, role, data, applies, choice }: ProviderCardData) {
	return (
		<article className="rounded-2xl bg-muted/35 p-5 sm:p-6">
			<div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
				<h3 className="text-lg font-medium text-foreground">{name}</h3>
				<p className="text-sm text-muted-foreground">{role}</p>
			</div>
			<dl className="mt-5 grid gap-4 text-sm leading-6 text-muted-foreground sm:grid-cols-3 sm:gap-6">
				<div>
					<dt className="font-medium text-foreground">Data categories</dt>
					<dd className="mt-1">{data}</dd>
				</div>
				<div>
					<dt className="font-medium text-foreground">When it applies</dt>
					<dd className="mt-1">{applies}</dd>
				</div>
				<div>
					<dt className="font-medium text-foreground">Your choice</dt>
					<dd className="mt-1">{choice}</dd>
				</div>
			</dl>
		</article>
	);
}

export default function SubprocessorsPage() {
	return (
		<LegalPageShell>
			<h1 className="mt-8 text-4xl font-semibold">
				Subprocessors &amp; third-party services
			</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				Effective September 9, 2026
			</p>
			<p className="mt-8 text-base leading-7 text-muted-foreground">
				This page identifies the service providers currently verified in
				Zuse&apos;s application and infrastructure configuration, and the
				independent services you may choose to connect. It is a feature-scoped
				description, not a promise that every provider is enabled for every
				account or environment.
			</p>

			<LegalSectionNav
				label="Subprocessors page sections"
				links={[
					{ href: "#zuse-providers", label: "Zuse providers" },
					{ href: "#your-services", label: "Your services" },
					{ href: "#transfers", label: "Transfers and changes" },
					{ href: "#choices", label: "Your choices" },
				]}
			/>

			<div className="mt-10 space-y-12 text-base leading-7 text-muted-foreground">
				<section id="zuse-providers">
					<h2 className="text-xl font-medium text-foreground">
						Zuse service providers
					</h2>
					<p className="mt-2">
						These providers process information on Zuse&apos;s behalf or provide
						a platform component that Zuse operates. The cards describe
						categories at a high level; a provider receives data only when the
						relevant feature is used.
					</p>
					<div className="mt-6 space-y-4">
						{zuseProviders.map((provider) => (
							<ProviderCard key={provider.name} {...provider} />
						))}
					</div>
				</section>

				<section id="your-services">
					<h2 className="text-xl font-medium text-foreground">
						Independent services you select
					</h2>
					<p className="mt-2">
						The services below are not Zuse subprocessors. You decide whether to
						connect them, and they process information under their own terms and
						privacy notices. Zuse may provide an adapter or user interface, but
						does not control the provider&apos;s systems or policies.
					</p>
					<div className="mt-6 space-y-4">
						{selectedServices.map((provider) => (
							<ProviderCard key={provider.name} {...provider} />
						))}
					</div>
				</section>

				<section id="transfers">
					<h2 className="text-xl font-medium text-foreground">
						Locations and international transfers
					</h2>
					<p className="mt-2">
						A provider may process information in a country different from where
						you live. This page does not list regions, hosting addresses,
						transfer mechanisms, retention periods, certifications, or
						contractual terms that are not verified in Zuse&apos;s current
						configuration and documentation. The applicable location and
						safeguards can vary by provider, account, plan, and feature.
					</p>
					<p className="mt-2">
						For more context about the local-first default, Cloud Workspaces,
						and provider boundaries, read the{" "}
						<Link
							href="/privacy"
							className="text-primary underline underline-offset-4"
						>
							Privacy Policy
						</Link>
						. A provider&apos;s own notice governs information it receives
						directly from you or from a connected client.
					</p>
				</section>

				<section id="choices">
					<h2 className="text-xl font-medium text-foreground">
						Your choices and provider changes
					</h2>
					<p className="mt-2">
						You can keep work local, choose whether to sign in, disable product
						analytics, decline mobile notifications, avoid Cloud Workspaces,
						choose which repositories and model providers to connect, and revoke
						access in the relevant provider. Removing a connection does not
						necessarily delete information already held by that provider; use
						its controls for that request.
					</p>
					<p className="mt-2">
						Zuse may add, remove, or replace a provider as the product changes.
						We will update this page and its effective date. If a change
						materially affects how Zuse handles personal information, we may
						also provide notice in the app or through another appropriate
						channel, consistent with the Privacy Policy. Release availability
						and beta configuration can change before a provider is enabled for
						you.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">Scope notes</h2>
					<ul className="mt-3 list-disc space-y-2 pl-5">
						<li>
							Local SQLite, operating-system credential stores, local files, and
							user-managed servers are not Zuse subprocessors.
						</li>
						<li>
							A feature marked optional, configurable, or private beta may be
							absent, disabled, or limited for your account or release.
						</li>
						<li>
							We do not list speculative vendors, disabled infrastructure
							adapters, or a provider merely because its software is bundled as
							a dependency.
						</li>
					</ul>
				</section>
			</div>
		</LegalPageShell>
	);
}
