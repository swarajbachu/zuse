import Link from "next/link";
import {
	LegalPageShell,
	LegalSectionNav,
} from "@/components/legal/legal-page-shell";
import { getSEO } from "@/lib/seo";
import { DISCORD_URL, GITHUB_URL } from "@/lib/site";

export const metadata = getSEO({
	title: "Data Rights & Account Deletion",
	description:
		"Practical controls for Zuse local data, account deletion, Cloud Workspaces, analytics, browser data, and privacy requests.",
	path: "/data-rights",
});

export default function DataRightsPage() {
	return (
		<LegalPageShell>
			<header className="mt-8">
				<h1 className="text-4xl font-semibold">
					Data rights &amp; account deletion
				</h1>
				<p className="mt-3 text-sm text-muted-foreground">
					Effective September 9, 2026
				</p>
				<p className="mt-6 text-lg leading-8 text-muted-foreground">
					This page is a practical guide to the controls that exist in Zuse
					today. It explains which action to choose when you want to remove
					local data, revoke access, delete a Cloud Workspace, stop analytics,
					or request help with information Zuse operates. It complements the{" "}
					<Link
						href="/privacy"
						className="text-primary underline underline-offset-4"
					>
						Privacy Policy
					</Link>
					, rather than replacing it.
				</p>
			</header>

			<LegalSectionNav
				label="Data rights sections"
				links={[
					{ href: "#choose-a-control", label: "Choose a control" },
					{ href: "#account-deletion", label: "Delete an account" },
					{ href: "#privacy-requests", label: "Privacy requests" },
					{ href: "#request-help", label: "Request help" },
				]}
			/>

			<div className="mt-10 space-y-10 text-base leading-7 text-muted-foreground">
				<section id="choose-a-control">
					<h2 className="text-xl font-medium text-foreground">
						Choose the narrowest control that fits
					</h2>
					<p className="mt-2">
						Zuse has local-first and account-linked paths. A control that
						removes a copy on one device does not automatically remove the
						source, a connected computer, a Cloud Workspace, or data held by a
						provider. Use this quick map before taking an irreversible action.
					</p>
					<div className="mt-5 overflow-x-auto rounded-2xl border border-border">
						<table className="w-full min-w-[620px] text-left text-sm leading-6">
							<caption className="sr-only">
								Zuse data controls and their effects
							</caption>
							<thead className="bg-muted/30 text-foreground">
								<tr>
									<th className="px-4 py-3 font-medium">Control</th>
									<th className="px-4 py-3 font-medium">Where</th>
									<th className="px-4 py-3 font-medium">What it changes</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border">
								<tr>
									<td className="px-4 py-3 text-foreground">Sign out</td>
									<td className="px-4 py-3">Desktop, mobile, or Serve</td>
									<td className="px-4 py-3">
										Ends the saved session or account link. It does not delete
										local workspaces, repositories, or provider accounts.
									</td>
								</tr>
								<tr>
									<td className="px-4 py-3 text-foreground">
										Clear downloaded data
									</td>
									<td className="px-4 py-3">Mobile Settings → Storage</td>
									<td className="px-4 py-3">
										Removes cached projects, chats, and messages from that
										phone; connections and unsent messages remain.
									</td>
								</tr>
								<tr>
									<td className="px-4 py-3 text-foreground">Reset app</td>
									<td className="px-4 py-3">Mobile Settings → Storage</td>
									<td className="px-4 py-3">
										Removes Zuse account state, connections, device keys, cache,
										pinned chats, and unsent messages from that phone. It does
										not delete the remote account or environment.
									</td>
								</tr>
								<tr>
									<td className="px-4 py-3 text-foreground">Delete account</td>
									<td className="px-4 py-3">Mobile Settings → Account</td>
									<td className="px-4 py-3">
										Permanently requests removal of the Zuse account and
										account-owned linked data described below. It cannot be
										undone.
									</td>
								</tr>
								<tr>
									<td className="px-4 py-3 text-foreground">
										Archive workspace
									</td>
									<td className="px-4 py-3">Cloud Workspace controls</td>
									<td className="px-4 py-3">
										Stops active use and places that hosted workspace in its
										archive lifecycle; it is not immediate permanent deletion.
									</td>
								</tr>
								<tr>
									<td className="px-4 py-3 text-foreground">
										Delete workspace
									</td>
									<td className="px-4 py-3">Cloud Workspace controls</td>
									<td className="px-4 py-3">
										Starts permanent hosted-workspace deletion and removes its
										encrypted hosted objects once the deletion completes.
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p className="mt-3 text-sm">
						These controls can be unavailable while a connection is offline or a
						lifecycle operation is still being reconciled. A failed or pending
						message is not proof that data was deleted; check the resulting
						state before removing any remaining local copy.
					</p>
				</section>

				<section id="account-deletion">
					<h2 className="text-xl font-medium text-foreground">
						Deleting your Zuse account
					</h2>
					<p className="mt-2">
						On mobile, open{" "}
						<strong className="font-medium text-foreground">
							Settings → Account → Delete account
						</strong>{" "}
						and confirm the destructive prompt. The mobile client sends an
						authenticated account-deletion request, then clears its local Zuse
						data. The account action is permanent and cannot be undone, so
						finish any important work and save anything you need first.
					</p>
					<p className="mt-2">
						The account endpoint removes account-owned control-plane records and
						managed infrastructure before removing the identity account. This
						includes linked computers or environments, mobile device
						registrations, account-owned Cloud Workspace records, cloud projects
						and related hosted objects when their deletion is safely fenced, and
						account entitlements. If cleanup is still pending, the service can
						return a pending result rather than claiming that every object has
						already disappeared.
					</p>
					<p className="mt-2">
						Deleting the account also clears the deleting phone&apos;s saved
						session, connections, device key, push registration, offline cache,
						pinned chats, crash marker, and analytics identity. It does not
						reach into other devices, your repositories, your operating-system
						credential store, your provider account, or a third party&apos;s
						records. Remove or rotate those separately when appropriate.
					</p>
					<p className="mt-2">
						Account deletion is different from signing out. Signing out ends
						access on that client while keeping account and local workspace
						data. It is also different from resetting the app: reset is a
						phone-local cleanup and leaves the remote account and environment in
						place.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Cloud Workspace archive and deletion
					</h2>
					<p className="mt-2">
						A Cloud Workspace is hosted data, not the local desktop database.
						Use its
						<strong className="font-medium text-foreground"> Archive</strong>{" "}
						action to stop active use while retaining a recovery path. The
						current product lifecycle retains an archived sandbox for 30 days,
						after which it is scheduled for permanent deletion if you take no
						further action. You can unarchive during that period when the
						control is available.
					</p>
					<p className="mt-2">
						Use{" "}
						<strong className="font-medium text-foreground">
							Delete workspace
						</strong>{" "}
						when you want to skip the archive period. It advances a deletion
						fence and asks the hosted runtime and storage layers to remove the
						sandbox and encrypted transcript objects. A successful control
						response means the deletion was accepted or completed according to
						the lifecycle state; it is not a promise about independent backups,
						provider retention, or data you copied elsewhere.
					</p>
					<p className="mt-2">
						Cloud transcript checkpoints are encrypted and are not a backup of
						the repository filesystem. Deleting a Cloud Workspace does not
						delete a Git repository on your computer or at a repository host,
						and deleting a local project does not delete an already-created
						Cloud Workspace.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Local files, browser data, and provider data
					</h2>
					<p className="mt-2">
						The ordinary desktop workspace stores chats, projects, settings, and
						related state in a local SQLite database on your computer.
						Repositories, worktrees, attachments, logs, exports, and backups can
						also exist as local files. Delete or back up those files through
						your operating system and ordinary repository workflow after
						confirming the exact path. Zuse cannot remotely inspect or erase
						data that exists only on your device, and uninstalling a managed
						runtime does not delete repositories or workspaces.
					</p>
					<p className="mt-2">
						Provider API keys are stored in the operating-system credential
						store and are not synced to a Zuse backend. Rotate or revoke them in
						the provider&apos;s own account controls, then remove the local
						credential if needed. Prompts, files, commands, and tool traffic
						sent to a model, repository host, package registry, browser site,
						notification service, or other integration are governed by that
						provider&apos;s policy and controls. Zuse cannot delete another
						provider&apos;s copy on your behalf.
					</p>
					<p className="mt-2">
						The built-in desktop browser has an isolated session. In Settings →
						Browser,{" "}
						<strong className="font-medium text-foreground">
							Clear imported
						</strong>{" "}
						removes the encrypted import record and any unchanged imported
						cookie. A cookie refreshed or replaced by the website can remain in
						the built-in browser session;{" "}
						<strong className="font-medium text-foreground">Clear all</strong>{" "}
						removes cookies, site storage, and cache from the built-in browser.
						Neither control changes your everyday browser or the source browser
						profile.
					</p>
					<p className="mt-2">
						See the{" "}
						<Link
							href="/cookies"
							className="text-primary underline underline-offset-4"
						>
							Cookie Policy
						</Link>{" "}
						for the website and built-in-browser distinction, and the{" "}
						<Link
							href="/security"
							className="text-primary underline underline-offset-4"
						>
							Security
						</Link>{" "}
						page for the trust boundaries around local, remote, and hosted data.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Analytics opt-out
					</h2>
					<p className="mt-2">
						Desktop product analytics are enabled by default. Mobile analytics
						require opt-in in Settings. Both are limited to the pseudonymous,
						sanitized events described in the{" "}
						<Link
							href="/privacy"
							className="text-primary underline underline-offset-4"
						>
							Privacy Policy
						</Link>
						. In Settings, turn off{" "}
						<strong className="font-medium text-foreground">
							Share usage analytics
						</strong>
						. New collection stops immediately and pending desktop and mobile
						analytics are deleted locally. Signing out, resetting the app, or
						deleting the account rotates the analytics identity; it does not
						retroactively erase already-collected pseudonymous aggregate
						history.
					</p>
					<p className="mt-2">
						This is separate from website cookies. The current marketing site
						does not run the desktop/mobile product-analytics system or a
						website analytics SDK.
					</p>
				</section>

				<section id="privacy-requests">
					<h2 className="text-xl font-medium text-foreground">
						Privacy request categories
					</h2>
					<p className="mt-2">
						Depending on the law that applies to you and the data involved, you
						may ask Zuse about the following:
					</p>
					<ul className="mt-3 list-disc space-y-2 pl-6">
						<li>
							<strong className="font-medium text-foreground">Access:</strong>{" "}
							ask what Zuse-operated personal information is handled and request
							a copy where available.
						</li>
						<li>
							<strong className="font-medium text-foreground">
								Correction:
							</strong>{" "}
							ask us to correct inaccurate account or support information.
						</li>
						<li>
							<strong className="font-medium text-foreground">Deletion:</strong>{" "}
							ask about removing Zuse-operated account or Cloud Workspace data,
							subject to the actual lifecycle state and applicable limits.
						</li>
						<li>
							<strong className="font-medium text-foreground">
								Restriction or objection:
							</strong>{" "}
							ask us to limit or stop a particular processing activity where the
							applicable rules provide that choice.
						</li>
						<li>
							<strong className="font-medium text-foreground">
								Portability:
							</strong>{" "}
							ask whether data you provided can be supplied in a usable format.
						</li>
						<li>
							<strong className="font-medium text-foreground">
								Analytics choice:
							</strong>{" "}
							opt out directly in app Settings; this does not erase prior
							aggregate history.
						</li>
					</ul>
					<p className="mt-3">
						A request is not automatically an instruction to delete every copy
						in the world. We may need to verify that you control the account and
						may need to preserve or decline a request where required by law,
						security, fraud prevention, dispute handling, or a valid legal
						process. The result also depends on whether the information is
						controlled by Zuse, stored only on your device, or held by an
						independent provider.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Identity verification and safe requests
					</h2>
					<p className="mt-2">
						To protect an account, we may ask for enough information to match a
						request to the relevant signed-in identity, such as the account
						email or other account identifier and the specific product or
						workspace involved. We will not ask you to publish a password, API
						key, private key, access token, cookie, recovery code, prompt,
						repository, or workspace contents in a public issue or community
						post. If you are unsure what is safe to share, describe the request
						at a high level first.
					</p>
					<p className="mt-2">
						Verification can limit what we disclose or change for a requester
						who cannot establish control of the account. Do not send a
						government ID or other sensitive document unless an official,
						verified follow-up channel actually requests it and you have
						reviewed what is necessary.
					</p>
				</section>

				<section id="request-help">
					<h2 className="text-xl font-medium text-foreground">
						Where to ask for help
					</h2>
					<p className="mt-2">
						For a non-sensitive privacy question or deletion-control problem,
						use an official Zuse channel: the{" "}
						<a
							href={GITHUB_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary underline underline-offset-4"
						>
							Zuse GitHub repository
						</a>{" "}
						or the{" "}
						<a
							href={DISCORD_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary underline underline-offset-4"
						>
							Zuse Discord community
						</a>
						. State whether you are asking about local data, an account, a
						device, or a Cloud Workspace, and include only the minimum
						non-sensitive detail needed to identify the issue. Do not put
						credentials or private workspace content in a public issue or
						community channel. For private support and account-specific privacy
						requests, email{" "}
						<a
							href="mailto:hi@zuse.sh"
							className="text-primary hover:underline"
						>
							hi@zuse.sh
						</a>
						. You can also use the in-app account deletion control.
					</p>
					<p className="mt-2">
						We do not publish an invented email address, fixed response
						deadline, jurisdiction, or deletion SLA on this page. The available
						controls and data paths can change; if a control is missing or its
						result is unclear, use one of the official channels above and
						describe what the app showed.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Related information
					</h2>
					<p className="mt-2">
						Read the{" "}
						<Link
							href="/privacy"
							className="text-primary underline underline-offset-4"
						>
							Privacy Policy
						</Link>
						,{" "}
						<Link
							href="/cookies"
							className="text-primary underline underline-offset-4"
						>
							Cookie Policy
						</Link>
						,{" "}
						<Link
							href="/security"
							className="text-primary underline underline-offset-4"
						>
							Security
						</Link>{" "}
						overview, and{" "}
						<Link
							href="/subprocessors"
							className="text-primary underline underline-offset-4"
						>
							Subprocessors
						</Link>{" "}
						list together when you need to trace a data path or understand which
						service controls a copy.
					</p>
				</section>
			</div>
		</LegalPageShell>
	);
}
