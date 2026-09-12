import Link from "next/link";
import { LegalPageShell } from "@/components/legal/legal-page-shell";
import { getSEO } from "@/lib/seo";
import { GITHUB_URL } from "@/lib/site";

export const metadata = getSEO({
	title: "Acceptable Use Policy",
	description:
		"Rules for safe, lawful, and responsible use of Zuse coding-agent workspaces and tools.",
	path: "/acceptable-use",
});

export default function AcceptableUsePage() {
	return (
		<LegalPageShell>
			<h1 className="mt-8 text-4xl font-semibold">Acceptable use policy</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				Effective September 9, 2026
			</p>

			<div className="mt-10 space-y-8 text-base leading-7 text-muted-foreground">
				<section>
					<h2 className="text-xl font-medium text-foreground">
						1. Purpose and scope
					</h2>
					<p className="mt-2">
						This Acceptable Use Policy (the “Policy”) describes uses that are
						not permitted when you use Zuse software, the Zuse website, Cloud
						Workspaces, or another Zuse-hosted feature (together, the
						“Services”). It applies to activity through a local device,
						connected provider, Git repository, remote or SSH environment,
						hosted workspace, browser or MCP tool, and activity performed by an
						agent or sub-agent using access you provide.
					</p>
					<p className="mt-2">
						This Policy is not a promise that Zuse can identify or prevent every
						violation. It works with the{" "}
						<Link
							href="/terms"
							className="text-primary underline underline-offset-4"
						>
							Terms of Service
						</Link>{" "}
						and the{" "}
						<Link
							href="/privacy"
							className="text-primary underline underline-offset-4"
						>
							Privacy Policy
						</Link>
						. If another written agreement or a provider’s terms impose a
						stricter restriction, follow the stricter restriction.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						2. Use the Services lawfully and safely
					</h2>
					<p className="mt-2">
						You may not use the Services to plan, facilitate, commit, conceal,
						or profit from unlawful conduct, or to create a foreseeable and
						serious risk of physical, financial, or digital harm. This includes
						using an agent to write, execute, distribute, or operate harmful
						code or instructions. A request is not permitted merely because it
						is framed as a test, research, fictional scenario, or educational
						exercise.
					</p>
					<p className="mt-2">
						Security testing, reverse engineering, and defensive research are
						allowed only when you have authorization, use an appropriately
						isolated target, stay within the agreed scope and rate, and avoid
						accessing, changing, or exposing real people’s data. You are
						responsible for preserving evidence, honoring disclosure
						requirements, and stopping when authorization or scope ends.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						3. Prohibited conduct
					</h2>
					<p className="mt-2">
						The following uses are prohibited. The list gives examples and does
						not make conduct lawful or permitted if it is not listed.
					</p>
					<ul className="mt-3 list-disc space-y-3 pl-6">
						<li>
							<strong className="font-medium text-foreground">
								Malware and credential theft.
							</strong>{" "}
							Creating or deploying ransomware, destructive malware, spyware,
							keyloggers, botnets, worms, unauthorized remote access,
							persistence, payloads, or tools intended to steal passwords, API
							keys, tokens, cookies, payment data, or other credentials;
							phishing or harvesting secrets; or exfiltrating data without
							authorization.
						</li>
						<li>
							<strong className="font-medium text-foreground">
								Unauthorized access and disruption.
							</strong>{" "}
							Breaking into accounts, repositories, devices, networks, or
							services; bypassing authentication, authorization, paywalls, rate
							limits, or security controls; exploiting a vulnerability against
							an unapproved target; scanning or enumerating systems outside an
							authorized scope; or degrading, disabling, deleting, or locking
							another system or user’s data.
						</li>
						<li>
							<strong className="font-medium text-foreground">
								Privacy violations and surveillance.
							</strong>{" "}
							Collecting, inferring, exposing, selling, or using personal,
							sensitive, medical, financial, location, biometric, or
							confidential information without the required permission or legal
							basis; doxxing, stalking, non-consensual tracking, or targeted
							surveillance; or using the Services to defeat a person’s
							reasonable privacy or security expectations.
						</li>
						<li>
							<strong className="font-medium text-foreground">
								Abuse, exploitation, and credible threats.
							</strong>{" "}
							Child sexual abuse material or sexual exploitation; trafficking;
							sexual content involving a person without their consent; targeted
							harassment, intimidation, extortion, or credible threats of
							violence; or instructions intended to facilitate such conduct.
						</li>
						<li>
							<strong className="font-medium text-foreground">
								Fraud and deceptive behavior.
							</strong>{" "}
							Impersonating a person or organization; creating phishing, scam,
							or fraud campaigns; forging records or evidence; manipulating
							reviews, votes, markets, or engagement; generating spam at scale;
							or hiding the source, purpose, or automated nature of
							communications when that information matters to the recipient.
						</li>
						<li>
							<strong className="font-medium text-foreground">
								Intellectual-property violations.
							</strong>{" "}
							Infringing copyright, trademarks, patents, or other rights;
							uploading trade secrets or confidential material without
							authorization; removing license notices or attribution; violating
							an open-source license; or circumventing DRM or another technical
							protection.
						</li>
						<li>
							<strong className="font-medium text-foreground">
								Platform and infrastructure abuse.
							</strong>{" "}
							Introducing malicious dependencies or scripts; using a workspace
							as a command-and-control host, proxy, relay, open scanner, or
							public file mirror; mining cryptocurrency; launching
							denial-of-service traffic; crawling or sending requests at abusive
							volume; consuming shared compute, storage, network, model, or API
							resources in a way that interferes with others; or testing service
							security without written authorization.
						</li>
					</ul>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						4. Credentials, permissions, and connected systems
					</h2>
					<p className="mt-2">
						Zuse can connect to provider accounts and, depending on your setup,
						give an agent access to project files, Git repositories and
						worktrees, a PTY terminal, network or browser tools, local or remote
						machines, SSH, and Cloud Workspaces. Some sessions can delegate work
						to sub-agents or continue after the desktop app closes. These
						capabilities are controlled by the environment, provider, enabled
						tools, and permission mode; they are not a license to access
						anything you can technically reach.
					</p>
					<p className="mt-2">
						Use only accounts, repositories, machines, data, and networks you
						are authorized to use. Give an agent only the access it needs.
						Review tool requests and commands before approving them, especially
						writes, shell execution, network requests, browser actions, Git
						operations, secrets, production systems, and destructive changes.
						Check queued messages, scheduled successor turns, sub-agent
						instructions, and background cloud work before you leave a session
						unattended. Stop a run and revoke access if its behavior or scope
						changes.
					</p>
					<p className="mt-2">
						Do not paste credentials into chats, prompts, files, issues, or
						commits, and do not direct an agent to find or reveal another
						person’s secrets. Protect local, mirrored, remote, and hosted copies
						of your content. You must also remove credentials from repositories,
						logs, artifacts, and transcripts if they are exposed and rotate them
						promptly.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						5. Provider and model rules
					</h2>
					<p className="mt-2">
						When you use a supported provider CLI, model, repository host,
						package registry, cloud environment, browser integration, or other
						connected service, its terms, usage policy, license, and limits also
						apply. You must follow the provider’s restrictions on content,
						automation, rate, commercial use, account sharing, and access.
						Provider approval does not make a use permitted under this Policy,
						and this Policy does not grant you rights to a provider’s service or
						data.
					</p>
					<p className="mt-2">
						Do not use Zuse to evade a provider’s safety system, model
						restriction, account suspension, usage cap, billing control,
						geographic restriction, or abuse-prevention measure. Do not rotate
						accounts, keys, IP addresses, models, or workspaces to conceal
						prohibited activity or obtain access you were denied. If a provider
						rejects, limits, or suspends a request, do not use Zuse to
						circumvent that decision.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						6. High-impact and autonomous decisions
					</h2>
					<p className="mt-2">
						Do not use an agent or automated workflow as the sole decision-maker
						for decisions that determine a person’s access to healthcare,
						emergency care, credit, insurance, employment, housing, education,
						public benefits, legal rights, or physical safety. Do not use it to
						control weapons, critical infrastructure, medical devices, or
						emergency systems without appropriate qualified human oversight,
						testing, safeguards, and a lawful operating process.
					</p>
					<p className="mt-2">
						An agent’s output may be incomplete, wrong, biased, insecure, or
						based on untrusted instructions. For any consequential use, a
						qualified person must review the relevant evidence, validate the
						result, and remain able to intervene. You remain responsible for
						decisions, deployments, messages, and external actions taken with
						Zuse, including actions by sub-agents or background sessions.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						7. Resource use and limits
					</h2>
					<p className="mt-2">
						Respect the limits shown by Zuse and each provider, including limits
						on requests, tokens, concurrent sessions, storage, compute, network
						traffic, and spend. Use retries, polling, sub-agents, scheduled
						turns, and cloud workspaces only for a legitimate task and at a
						reasonable rate. You may not evade a limit or overage cap, create
						duplicate work to increase capacity, or leave unattended work
						running to consume resources.
					</p>
					<p className="mt-2">
						Do not use the Services to provide a competing hosted service,
						resell compute or model access, or operate a high-volume public API,
						crawler, proxy, or job runner without express written authorization.
						Zuse may apply practical limits or pause an environment when needed
						to protect the Service, users, providers, or infrastructure.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						8. Reporting and response
					</h2>
					<p className="mt-2">
						If you discover exposed credentials, unauthorized access, malicious
						activity, or a security issue involving Zuse, stop the activity
						where possible, preserve only the information needed to explain it,
						avoid accessing more data, and report it through the project’s{" "}
						<a
							href={`${GITHUB_URL}/issues`}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary underline underline-offset-4"
						>
							GitHub Issues
						</a>{" "}
						page. Do not include passwords, tokens, private keys, personal data,
						or other sensitive content in a public issue.
					</p>
					<p className="mt-2">
						Zuse may investigate reports and activity available to it,
						consistent with the Privacy Policy and applicable law. Where
						reasonably necessary, Zuse may warn, restrict, suspend, or terminate
						access to an account, provider connection, workspace, session, or
						feature; remove or decline content; preserve relevant records; or
						refer conduct to a provider or law-enforcement authority. Zuse may
						act without advance notice when needed to address an urgent risk. We
						do not promise that every report will be verified, that every
						violation will be detected, or that a particular enforcement action
						will be taken.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						9. Policy changes
					</h2>
					<p className="mt-2">
						We may update this Policy as the Services, providers, or applicable
						requirements change. The current version will be posted on this page
						with a revised effective date. If a change is material and notice is
						reasonably practicable, we may provide additional notice through the
						Services or another available channel. Continuing to use the
						Services after the updated Policy takes effect means you accept the
						update, except where applicable law requires a different process.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">10. Contact</h2>
					<p className="mt-2">
						For questions about this Policy or to report a possible violation,
						use the project’s{" "}
						<a
							href={`${GITHUB_URL}/issues`}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary underline underline-offset-4"
						>
							GitHub Issues
						</a>{" "}
						page. Please share only the minimum detail needed and redact
						sensitive information.
					</p>
				</section>
			</div>
		</LegalPageShell>
	);
}
