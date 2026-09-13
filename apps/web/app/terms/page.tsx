import Link from "next/link";
import { LegalPageShell } from "@/components/legal/legal-page-shell";
import { getSEO } from "@/lib/seo";
import { GITHUB_URL } from "@/lib/site";

export const metadata = getSEO({
	title: "Terms of Service",
	description:
		"Terms governing use of Zuse software, Cloud Workspaces, and related services.",
	path: "/terms",
});

export default function TermsPage() {
	return (
		<LegalPageShell>
			<h1 className="mt-8 text-4xl font-semibold">Terms of service</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				Effective September 9, 2026
			</p>

			<div className="mt-10 space-y-8 text-base leading-7 text-muted-foreground">
				<section>
					<h2 className="text-xl font-medium text-foreground">
						1. Agreement and scope
					</h2>
					<p className="mt-2">
						These Terms of Service (the “Terms”) govern your download, access
						to, and use of Zuse software, the Zuse website, and any related
						hosted services that are made available to you (together, the
						“Services”). By using the Services, you agree to these Terms. If you
						use the Services on behalf of an organization, you represent that
						you have authority to bind that organization, and “you” includes
						that organization.
					</p>
					<p className="mt-2">
						Do not use the Services if you cannot agree to these Terms. You must
						be old enough to form a binding agreement where you live and must
						comply with all rules that apply to your use. If you are below the
						age at which you can do so, a parent or legal guardian must accept
						these Terms for you.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						2. What Zuse provides
					</h2>
					<p className="mt-2">
						Zuse is a workspace for working with supported coding-agent tools.
						The desktop application can organize conversations, project files,
						terminals, Git repositories and worktrees, and provider sessions.
						Some features depend on your device, operating system, installed
						command-line tools, network, and chosen provider.
					</p>
					<p className="mt-2">
						Cloud Workspaces are an invite-only beta and may have separate
						access, capacity, account, or subscription requirements. Mobile and
						other clients may be limited, experimental, or unavailable. Product
						pages, documentation, and the release notes describe current
						availability; they do not promise that a feature will remain
						available or work in every environment.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						3. Accounts and access
					</h2>
					<p className="mt-2">
						Certain Services may require an account or an invitation. Give
						accurate information, keep account credentials and recovery methods
						secure, and promptly address unauthorized access. You are
						responsible for activity performed through your account or devices
						unless applicable law says otherwise. Do not share access in a way
						that bypasses account, seat, invitation, or security controls.
					</p>
					<p className="mt-2">
						You may connect accounts, API credentials, or locally installed
						clients from third-party model and coding-agent providers. You
						remain responsible for safeguarding those credentials, keeping your
						connected accounts in good standing, and removing access you no
						longer intend Zuse to use.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						4. License to use the Services
					</h2>
					<p className="mt-2">
						Subject to these Terms, Zuse grants you a limited, non-exclusive,
						non-transferable, revocable right to use the Services for their
						intended purpose. This right does not give you ownership of the
						Services, their branding, or proprietary service materials. You may
						not rent, resell, lease, sublicense, or provide access to the
						Services except as expressly permitted in writing or by an
						applicable open-source license.
					</p>
					<p className="mt-2">
						The source code has its own license notices. Except where
						third-party terms apply, the repository is licensed under the GNU
						Affero General Public License version 3 only. Those open-source
						license terms govern your rights in the covered source code; these
						Terms govern use of the Services and do not take away rights that
						the applicable open-source license grants.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						5. Your content, projects, and permissions
					</h2>
					<p className="mt-2">
						You retain your rights in the code, prompts, files, repositories,
						credentials, and other material you provide or make available
						through the Services (“Your Content”). You are responsible for
						having all rights, permissions, notices, and consents needed to use
						Your Content with Zuse, your chosen providers, and any environment
						you connect.
					</p>
					<p className="mt-2">
						You control what a local session can reach through your
						operating-system, repository, provider, and permission settings.
						Before enabling a hosted workspace, remote session, sync path, or
						provider connection, confirm that you are authorized to transfer the
						relevant content and to let it be processed in that environment.
						Keep backups and use version control or other recovery practices
						appropriate to the importance of your work.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						6. Agents, tools, and human review
					</h2>
					<p className="mt-2">
						Coding agents can be capable of reading files, proposing or changing
						code, creating Git worktrees, running commands and tests, using
						connected tools, and producing outputs that affect a repository or
						external system. Their capabilities depend on the provider, the
						tools you enable, and the permissions you grant. You are responsible
						for deciding what access is appropriate and for reviewing,
						approving, testing, and backing up work before relying on it or
						deploying it.
					</p>
					<p className="mt-2">
						Do not grant an agent access to secrets, production systems, payment
						accounts, personal data, or destructive commands unless you
						understand and accept the resulting risk. Zuse does not make an
						agent’s output, command, tool action, commit, security conclusion,
						or test result a guarantee of correctness, safety, legality,
						availability, or fitness for any purpose.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						7. Third-party providers and services
					</h2>
					<p className="mt-2">
						Zuse is not a model provider or a reseller of your third-party agent
						accounts. When you choose a provider, model, repository host,
						package registry, cloud environment, or other integration, that
						party’s terms, privacy practices, availability, prices, usage
						limits, and restrictions also apply. Your requests, content,
						credentials, and outputs may be processed by those services
						according to your settings and their terms.
					</p>
					<p className="mt-2">
						Zuse does not control third-party services and is not responsible
						for their acts, omissions, outputs, outages, account decisions, or
						changes. A third-party change may limit or stop an integration
						without creating an obligation for Zuse to replace it.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						8. Local and cloud data
					</h2>
					<p className="mt-2">
						For local use, chats, project data, and settings are designed to
						remain on your devices, subject to the provider and integrations you
						choose. For hosted use, the Service may process and retain the data
						needed to provide the workspace, including project and session
						information, within the hosted environment and its supporting
						systems. The Privacy Policy explains Zuse’s data practices and
						controls and is part of your use of the Services.
					</p>
					<p className="mt-2">
						You are responsible for choosing an appropriate workspace,
						configuring access carefully, and deleting or revoking data and
						credentials when they are no longer needed. Local and remote
						environments have different storage, network, and recovery
						characteristics; do not treat either as a substitute for your own
						security or retention obligations.
					</p>
					<p className="mt-2">
						Read the{" "}
						<Link
							href="/privacy"
							className="text-primary underline underline-offset-4"
						>
							Privacy Policy
						</Link>{" "}
						for more information.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						9. Acceptable use
					</h2>
					<p className="mt-2">
						You must use the Services lawfully and responsibly, and may not use
						them to compromise systems, evade access controls, violate
						intellectual-property rights, invade privacy, distribute harmful
						code, or interfere with the Services or others. The complete rules
						are in the{" "}
						<Link
							href="/acceptable-use"
							className="text-primary underline underline-offset-4"
						>
							Acceptable Use Policy
						</Link>
						.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						10. Fees and subscriptions
					</h2>
					<p className="mt-2">
						If you purchase a paid Service, the price, billing cadence, included
						usage, applicable taxes, and any service-specific conditions will be
						presented with that purchase or order. You agree to pay the
						disclosed charges and to keep the associated payment method
						authorized. These Terms do not themselves establish a price, a
						subscription plan, or a refund policy. Nothing here limits rights
						that cannot be waived under applicable law.
					</p>
					<p className="mt-2">
						Where a recurring subscription is offered, its renewal and
						cancellation controls will be shown in the checkout or billing
						portal. Usage-based charges, caps, and taxes apply only when
						disclosed for that offer. Stop future renewal through the available
						billing control before the next billing date; cancellation does not
						by itself promise a refund for a completed period or charge.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						11. Intellectual property and feedback
					</h2>
					<p className="mt-2">
						Except for Your Content and rights granted by applicable open-source
						licenses, Zuse and its licensors retain all rights in the Services,
						including their design, documentation, and marks. If you provide
						ideas, comments, or suggestions, you grant Zuse permission to use
						them without restriction or compensation. Please do not send
						feedback that you expect to be kept confidential.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						12. Availability, beta features, and updates
					</h2>
					<p className="mt-2">
						The Services may change, be updated, interrupted, or discontinued.
						Beta, preview, and experimental features may be incomplete, contain
						errors, or be withdrawn without advance notice. You should not rely
						on them for critical, emergency, or irreversible work. Downloads and
						updates may be offered through release channels, but you are
						responsible for evaluating updates and maintaining a compatible
						environment.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						13. Suspension and termination
					</h2>
					<p className="mt-2">
						You may stop using the Services at any time. Zuse may limit,
						suspend, or terminate access to a hosted or account-based Service
						where reasonably necessary to protect users, the Service, third
						parties, or the law; for a material breach of these Terms; or where
						access is no longer available. Where practical, Zuse will provide
						notice. Sections that by their nature should survive, including
						those concerning intellectual property, disclaimers, limitations,
						indemnity, and disputes, continue after termination.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						14. Disclaimers and limitation of liability
					</h2>
					<p className="mt-2">
						To the maximum extent permitted by applicable law, the Services are
						provided “as is” and “as available.” Zuse disclaims implied
						warranties, including merchantability, fitness for a particular
						purpose, non-infringement, and uninterrupted or error-free
						operation. Zuse does not warrant that the Services, agents,
						integrations, outputs, or hosted environments will meet your
						requirements or be secure, accurate, complete, or available at any
						particular time.
					</p>
					<p className="mt-2">
						To the maximum extent permitted by applicable law, Zuse will not be
						liable for indirect, incidental, special, consequential, exemplary,
						or punitive damages, or for lost profits, revenue, goodwill, data,
						or business opportunity, arising from or related to the Services.
						Where liability cannot lawfully be excluded, it is limited only to
						the extent allowed by applicable law. These limits do not exclude
						liability that cannot be excluded under that law.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">15. Indemnity</h2>
					<p className="mt-2">
						To the extent permitted by applicable law, you will defend and
						indemnify Zuse and its contributors, licensors, and service
						providers against third-party claims and related losses arising from
						Your Content, your unauthorized use of the Services, your violation
						of these Terms, or your violation of another person’s rights. This
						obligation applies only where your conduct caused the claim.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						16. Disputes, consumer rights, and changes
					</h2>
					<p className="mt-2">
						These Terms do not name a governing law, exclusive venue, or
						arbitration process because no such selection is stated here. An
						executed agreement or service-specific order may contain additional
						terms where it clearly says so. Nothing in these Terms is intended
						to exclude, restrict, or override consumer protections or other
						rights that applicable law does not permit to be waived.
					</p>
					<p className="mt-2">
						Zuse may update these Terms as the Services evolve. The updated
						version will be posted here with a revised effective date. If a
						change is material and notice is reasonably practicable, Zuse will
						provide additional notice through the Service or another available
						channel. Continuing to use the Services after the revised Terms take
						effect means you accept them, except where applicable law requires a
						different process.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">17. Contact</h2>
					<p className="mt-2">
						For questions about these Terms or to report an issue with the
						Services, use the project’s{" "}
						<a
							href={`${GITHUB_URL}/issues`}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary underline underline-offset-4"
						>
							GitHub Issues
						</a>{" "}
						page.
					</p>
				</section>
			</div>
		</LegalPageShell>
	);
}
