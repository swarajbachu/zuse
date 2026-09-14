import Link from "next/link";
import {
	LegalPageShell,
	LegalSectionNav,
} from "@/components/legal/legal-page-shell";
import { getSEO } from "@/lib/seo";
import { GITHUB_URL } from "@/lib/site";

export const metadata = getSEO({
	title: "Security & Data Practices",
	description:
		"How Zuse separates local, remote, mobile, and Cloud Workspace security boundaries; protects credentials and data; and helps you use coding agents safely.",
	path: "/security",
});

export default function SecurityPage() {
	return (
		<LegalPageShell>
			<h1 className="mt-8 text-4xl font-semibold">
				Security &amp; data practices
			</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				Current as of September 9, 2026
			</p>
			<p className="mt-8 text-base leading-7 text-muted-foreground">
				Zuse is designed so that the ordinary coding workspace runs on a
				computer you control. Optional remote access, mobile clients, and Cloud
				Workspaces intentionally create different data paths. This page explains
				those boundaries, the controls built into the current product design,
				and the decisions that remain yours when an agent can read files, run
				commands, or use connected services.
			</p>

			<LegalSectionNav
				label="Security and data practice sections"
				links={[
					{ href: "#boundaries", label: "Boundaries" },
					{ href: "#credentials", label: "Credentials" },
					{ href: "#cloud", label: "Cloud Workspaces" },
					{ href: "#your-role", label: "Your role" },
					{ href: "#reporting", label: "Report a concern" },
				]}
			/>

			<div className="mt-10 space-y-10 text-base leading-7 text-muted-foreground">
				<section id="boundaries">
					<h2 className="text-xl font-medium text-foreground">
						Security starts with the environment
					</h2>
					<p className="mt-2">
						Zuse treats the desktop, a remote computer, a paired mobile device,
						the hosted control plane, a Cloud Workspace runtime, and cloud
						storage as distinct security boundaries. Connecting a client to an
						environment lets it control that environment; it does not move the
						repository, terminal, provider CLI, or its credentials onto the
						client by default.
					</p>
					<p className="mt-2">
						In the normal local desktop workflow, chats, project state,
						settings, and related workspace data stay on your computer. A
						prompt, attached file, command, or tool result may still leave that
						computer when you send it to a model provider or another service you
						have chosen to connect. Local-first is not the same as offline or
						air-gapped.
					</p>
					<p className="mt-2">
						An SSH environment runs on the remote host you configure. Zuse can
						use that host through your existing SSH setup and keeps the same
						environment-level connection and approval model, but it cannot make
						a remote operating system, network, administrator, or repository
						policy safe on your behalf. Treat that host as a separate computer
						with its own access controls, backups, patching, and provider
						credentials.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Account authentication and authorization
					</h2>
					<p className="mt-2">
						You can use the core local workspace without a Zuse account. Where
						an account is required, Zuse uses a public-client authorization flow
						in the system browser. The desktop keeps the resulting session in
						platform-protected storage; the renderer receives a non-secret
						profile and expiry information rather than account access or refresh
						tokens.
					</p>
					<p className="mt-2">
						Hosted operations are authorized on the server using the verified
						account identity. The product does not rely on a client-supplied
						account identifier or a feature flag evaluated in the user interface
						to grant hosted access. Access removal prevents new hosted
						operations and reconnects; an already accepted runtime turn may be
						allowed to settle through internal lifecycle callbacks so that its
						state is not left in an ambiguous partial transition.
					</p>
				</section>

				<section id="credentials">
					<h2 className="text-xl font-medium text-foreground">
						Credentials and browser data
					</h2>
					<p className="mt-2">
						For app-managed provider credentials, Zuse uses an encrypted local
						vault whose master key is held by the operating system credential
						store. Individual provider secrets are not exposed to the renderer;
						the user interface can learn that a provider is configured without
						receiving its secret. Native provider CLIs may also maintain their
						own authentication stores, which remain subject to the
						provider&apos;s security model.
					</p>
					<p className="mt-2">
						The built-in desktop browser uses its own isolated partition. If you
						explicitly import cookies from a local browser profile, Zuse copies
						them into that built-in browser; stored imported cookie values are
						encrypted with the app vault for restoration after restart. You can
						clear the encrypted import record and unchanged imported cookies, or
						clear all built-in browser cookies, site storage, and cache in
						desktop settings. A cookie refreshed by a website may require the
						clear-all control. Those controls do not alter the original browser
						profile.
					</p>
					<p className="mt-2">
						Browser sign-in data is sensitive. Use the system credential picker
						only for the site you intend, confirm the displayed site and
						account, and clear imported browser data when it is no longer
						required. Never paste provider tokens, SSH private keys, recovery
						codes, or production credentials into a prompt, issue, diagnostic,
						or chat you do not trust.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Mobile pairing and remote clients
					</h2>
					<p className="mt-2">
						Local browser and phone access are off until you enable them. A
						pairing link or QR code is single-use and expires after five
						minutes. Each approved browser or phone receives its own revocable
						credential, and you can review and revoke connected devices from the
						environment that issued access.
					</p>
					<p className="mt-2">
						Nearby phone pairing requires explicit approval on the Mac. The
						phone checks the advertised encrypted transport identity, and both
						screens display a derived safety phrase to help you detect a
						mismatched pairing attempt. The phone stores its private pairing key
						in secure device storage; the approved credential is encrypted to
						that device key before it leaves the Mac.
					</p>
					<p className="mt-2">
						A paired phone or browser is a remote control for the computer
						running Zuse, not a copy of that computer. Provider credentials
						remain on the execution environment, but a connected client may
						observe workspace content and approve work. Revoke an unfamiliar
						device promptly; if it may have observed an active session, also
						rotate affected provider, repository, and service credentials.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Agent permissions are a deliberate control
					</h2>
					<p className="mt-2">
						Agent capabilities depend on the selected provider, tool, permission
						posture, and operating-system account. Zuse presents permission
						requests for actions such as file writes, shell commands, and
						network access. Sensitive file paths and plan-oriented workflows can
						require a fresh decision. Decisions can be limited to one action or
						a session, and saved decisions can be reviewed and revoked where
						available.
					</p>
					<p className="mt-2">
						Read each request and choose the narrowest option that allows the
						work you intend. Permission prompts are not a sandbox around all
						code an agent, provider, or connected tool might execute, and they
						do not replace operating-system permissions, source-control
						protections, network controls, or code review.
					</p>
				</section>

				<section id="cloud">
					<h2 className="text-xl font-medium text-foreground">
						Cloud Workspaces: separate control and data paths
					</h2>
					<p className="mt-2">
						Cloud Workspaces are an optional private beta. A workspace runs in
						an isolated hosted sandbox rather than on your computer. The hosted
						control plane handles verified identity, authorization, lifecycle,
						short-lived connection tickets, catalog metadata, and checkpoint
						pointers. The runtime handles the repository, worktree, agent
						process, terminal, and writable session state.
					</p>
					<p className="mt-2">
						Clients use tickets bound to the account, device, workspace, role,
						protocol version, runtime generation, and gateway epoch. The live
						gateway validates a ticket before attaching and forwards opaque
						binary frames; it is not a transcript store, command queue, or
						replay log. Durable eligible commands are stored as AES-GCM
						ciphertext with authenticated routing metadata, then decrypted and
						applied by the authorized workspace runtime.
					</p>
					<p className="mt-2">
						Cloud provider and repository credentials are stored encrypted and
						are delivered only to the authenticated workspace runtime. Reusable
						provider credentials are held by a dedicated account-scoped
						authority; a short-lived, provider-bound grant is encrypted to the
						enrolled runtime key when it is needed. The API and live gateway are
						not designed to receive those credentials in plaintext. Prepared
						project snapshots and base templates are credential-free, and
						snapshot preparation removes known repository tokens, runtime
						identity, authorized keys, and shell history before publication.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Encrypted transcript checkpoints and lifecycle
					</h2>
					<p className="mt-2">
						A Cloud Workspace runtime remains the writable session authority. It
						can produce bounded transcript projections for cross-device
						catch-up. Each checkpoint is compressed and encrypted with
						AES-256-GCM, with the workspace, session, cursor, and schema
						information authenticated to prevent a valid checkpoint from being
						moved to a different workspace or cursor. Object storage receives
						immutable ciphertext; the API verifies the object hash, size,
						runtime generation, and monotonic cursor before advancing the latest
						pointer.
					</p>
					<p className="mt-2">
						Authorized owning clients receive the checkpoint key through the
						protected checkpoint path and decrypt with integrity checks. This is
						not a claim that every Cloud Workspace interaction is end-to-end
						encrypted, nor is a transcript checkpoint a backup of the complete
						filesystem, terminal stream, credentials, or writable command queue.
					</p>
					<p className="mt-2">
						Pausing preserves the same hosted sandbox and attempts a final
						checkpoint. Archiving retains the paused sandbox for a 30-day trash
						window; permanent deletion removes the sandbox, transcript objects,
						checkpoint pointers, wrapped transcript keys, launch content, and
						runtime access material once deletion completes. A content-free
						tombstone briefly remains so offline devices can remove cached
						content.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Sandbox isolation and hosted access limits
					</h2>
					<p className="mt-2">
						A Cloud Workspace is isolated compute, not an assertion that
						arbitrary code is harmless. The workspace can run tools and access
						repositories, credentials, network destinations, and integrations
						that you make available to it. Treat it as a distinct environment:
						use least-privilege credentials, keep unrelated secrets out of the
						workspace, and review what an agent is asked to do before enabling
						broader access.
					</p>
					<p className="mt-2">
						Cloud SSH access uses a short-lived, ticket-gated WebSocket bridge
						and a per-workspace host key rather than a public provider SSH
						listener. A workspace preview URL, when you create one, is public to
						anyone who has the high-entropy URL until the sandbox identity is
						retired. Do not put private development services, credentials, or
						sensitive data behind a preview URL unless that exposure is
						appropriate for the service.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Updates, dependencies, and service operations
					</h2>
					<p className="mt-2">
						Cloud runtime releases are built from an exact release commit and
						use immutable artifacts. The runtime channel verifies a signature
						and checksum before use. Compatible in-place updates retain the
						previous release and only complete after enrollment and health
						checks; a failed update can restore that previous runtime.
						Incompatible versions stop with an explicit update requirement
						rather than silently using a partial compatibility path.
					</p>
					<p className="mt-2">
						Zuse maintains declared dependencies and version-locked installs in
						the source tree, but no dependency or update process can remove
						every risk. Keep your Zuse installation, operating system, browser,
						provider CLIs, and remote hosts current through their supported
						update channels. Test and review changes before deploying
						agent-produced code or relying on it in production.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Diagnostics and product analytics
					</h2>
					<p className="mt-2">
						Product analytics use a pseudonymous installation identity. Event
						collection is allowlisted and fail-closed: unknown events, unknown
						properties, suspicious keys, unsupported values, and unbounded
						strings are discarded before delivery. The analytics design excludes
						prompts, responses, reasoning, tool input and output, commands,
						source code, file paths, repository names, URLs, account
						identifiers, credentials, tokens, diagnostic contents, and error
						stacks. You can turn off usage analytics in desktop or mobile
						settings.
					</p>
					<p className="mt-2">
						Remote connection diagnostics redact sensitive values by key and
						remove common token-bearing query parameters, bearer values, and
						token-shaped strings before export. Redaction reduces risk; it is
						not a reason to share raw diagnostic files carelessly. Review any
						diagnostic bundle for workspace information before sharing it, and
						remove secrets yourself if you find them.
					</p>
				</section>

				<section id="your-role">
					<h2 className="text-xl font-medium text-foreground">
						Your security responsibilities
					</h2>
					<ul className="mt-3 list-disc space-y-2 pl-5">
						<li>
							Use a device account with only the repository and tool access the
							intended work needs. Do not run remote developer environments as
							an administrator or root user merely for convenience.
						</li>
						<li>
							Protect your operating system, account recovery methods, provider
							accounts, source-control account, SSH keys, and network. Rotate
							and revoke credentials when access may have been exposed.
						</li>
						<li>
							Enable remote access only when needed, keep pairing links private,
							match nearby-pairing safety phrases, and periodically review
							connected devices and saved permission decisions.
						</li>
						<li>
							Use version control, backups, code review, tests, and deployment
							controls appropriate to the impact of an agent&apos;s work. An
							agent output, command, test result, or security conclusion is not
							a guarantee.
						</li>
					</ul>
				</section>

				<section id="reporting">
					<h2 className="text-xl font-medium text-foreground">
						Report a security concern responsibly
					</h2>
					<p className="mt-2">
						If you believe a device, account, pairing credential, or workspace
						may be compromised, first revoke the affected device or credential
						and turn off remote or hosted access while you investigate. Preserve
						only the non-sensitive facts needed to reproduce the issue, such as
						the product version, operating system, and a redacted description of
						the behavior.
					</p>
					<p className="mt-2">
						For a non-sensitive service problem, use the project&apos;s verified{" "}
						<a
							href={`${GITHUB_URL}/issues`}
							className="text-primary underline underline-offset-4"
						>
							GitHub Issues
						</a>{" "}
						page. Do not post credentials, personal data, active access links,
						exploit instructions, or unredacted diagnostics in a public issue.
						For a potential vulnerability, check the project&apos;s GitHub
						Security tab for a private reporting option. If one is not
						available, open a minimal public issue requesting a secure
						coordination channel, without including sensitive technical details.
					</p>
					<p className="mt-2">
						Use only contact and reporting links published by Zuse in the app,
						website, or repository. Zuse does not publish a fixed
						incident-response time, a bug bounty, a security certification, or a
						guarantee that every vulnerability can be prevented or resolved
						within a particular period.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Limits of this page
					</h2>
					<p className="mt-2">
						Security is a shared, changing practice. This page describes the
						current product design; it is not a certification, audit report,
						contractual security commitment, or substitute for your own risk
						assessment. Third-party providers, operating systems, networks,
						browsers, repositories, integrations, and the code an agent runs
						each have their own security and privacy characteristics. No system
						can guarantee absolute security.
					</p>
					<p className="mt-2">
						Read the{" "}
						<Link
							href="/privacy"
							className="text-primary underline underline-offset-4"
						>
							Privacy Policy
						</Link>{" "}
						and{" "}
						<Link
							href="/terms"
							className="text-primary underline underline-offset-4"
						>
							Terms of Service
						</Link>{" "}
						for related information about data handling and use of Zuse.
					</p>
				</section>
			</div>
		</LegalPageShell>
	);
}
