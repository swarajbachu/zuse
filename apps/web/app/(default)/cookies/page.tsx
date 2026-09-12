import Link from "next/link";
import { LegalPageShell } from "@/components/legal/legal-page-shell";
import { getSEO } from "@/lib/seo";
import { DISCORD_URL, GITHUB_URL } from "@/lib/site";

export const metadata = getSEO({
	title: "Cookie Policy",
	description:
		"How Zuse uses cookies and browser storage on its website, and how that differs from the desktop app's explicit browser-session import.",
	path: "/cookies",
});

export default function CookiesPage() {
	return (
		<LegalPageShell>
			<header className="mt-8">
				<h1 className="text-4xl font-semibold">Cookie policy</h1>
				<p className="mt-3 text-sm text-muted-foreground">
					Effective September 9, 2026
				</p>
				<p className="mt-6 text-lg leading-8 text-muted-foreground">
					This policy explains what cookies and similar browser storage are,
					what Zuse currently uses on this website, and how that is different
					from the explicit browser-session import available in the Zuse desktop
					app.
				</p>
			</header>

			<div className="mt-10 space-y-10 text-base leading-7 text-muted-foreground">
				<section>
					<h2 className="text-xl font-medium text-foreground">
						What this policy covers
					</h2>
					<p className="mt-2">
						This policy applies to cookies and similar technologies used when
						you visit the Zuse marketing website, including pages at this site
						and the public waitlist form. It does not replace the{" "}
						<Link
							href="/privacy"
							className="text-primary underline underline-offset-4"
						>
							Privacy Policy
						</Link>{" "}
						or describe the cookie practices of websites that Zuse links to.
						Those sites have their own operators, policies, and browser
						controls.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						What cookies and storage are
					</h2>
					<p className="mt-2">
						A cookie is a small value that a website asks your browser to store
						and return with later requests. Similar technologies include local
						storage, session storage, and other browser-managed state. They can
						remember a preference, keep a requested feature working, or help a
						service understand how it is being used. The browser, not the page
						itself, controls whether these values can be stored; the website or
						service can request an expiry, subject to browser rules.
					</p>
				</section>

				<section className="rounded-2xl border border-border bg-muted/20 p-6">
					<h2 className="text-xl font-medium text-foreground">
						Two different meanings of “cookies”
					</h2>
					<p className="mt-2">
						The website and the desktop app use the word <em>cookies</em> for
						two different things. A website cookie is browser state created
						while visiting this site. An imported browser cookie is an existing
						sign-in session that you deliberately copy from another browser
						profile into the isolated browser inside the desktop app. Visiting
						this website does not cause Zuse to read your other browser’s
						cookies, and the desktop import does not give the website access to
						your source browser profile.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Categories we use to describe storage
					</h2>
					<p className="mt-2">
						These categories are a plain-language way to explain the role of a
						cookie or storage value. A particular browser or deployment may use
						a value differently, so this page describes purposes rather than
						promising particular cookie names or exact expiration dates.
					</p>
					<dl className="mt-5 space-y-5">
						<div>
							<dt className="font-medium text-foreground">
								Strictly necessary
							</dt>
							<dd className="mt-1">
								Storage that is needed to deliver a page, maintain a requested
								security or routing function, or process a feature you chose to
								use. Turning this off can prevent the site or that feature from
								working.
							</dd>
						</div>
						<div>
							<dt className="font-medium text-foreground">Preference</dt>
							<dd className="mt-1">
								Storage that remembers a choice, such as the website’s
								appearance, so you do not have to make it again on every visit.
								The current site can store the selected theme in browser
								storage; this is not a tracking cookie.
							</dd>
						</div>
						<div>
							<dt className="font-medium text-foreground">Analytics</dt>
							<dd className="mt-1">
								Storage used to measure visits or feature use across the
								website. The current marketing website does not use Zuse’s
								desktop and mobile product-analytics system, and no website
								analytics SDK is configured in the current site.
							</dd>
						</div>
						<div>
							<dt className="font-medium text-foreground">Third-party</dt>
							<dd className="mt-1">
								Storage set by a service other than the page’s operator. The
								current website does not embed an advertising network, social
								widget, or third-party analytics SDK. A linked service may set
								its own cookies after you leave Zuse; its policy controls those
								cookies.
							</dd>
						</div>
					</dl>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Current website practice
					</h2>
					<p className="mt-2">
						As of the effective date above, the marketing site does not
						intentionally set advertising cookies or run a website analytics
						program. It has no website account sign-in flow evidenced in the
						current public routes, and the public waitlist endpoint does not
						require authentication. The site may still use browser-managed state
						needed by the web framework or a feature you request. For example,
						the appearance preference can be kept in local storage rather than a
						server cookie.
					</p>
					<p className="mt-3">
						The Zuse desktop and mobile apps have separate product behavior.
						Their usage analytics are described in the{" "}
						<Link
							href="/privacy"
							className="text-primary underline underline-offset-4"
						>
							Privacy Policy
						</Link>
						. A desktop or cloud authentication flow may open a provider or
						service-owned page in a browser; any cookies that page sets belong
						to that service, not to this marketing website.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						The desktop browser-session import
					</h2>
					<p className="mt-2">
						Zuse does not passively enumerate browser credentials. In the
						desktop app, you can explicitly choose{" "}
						<strong className="text-foreground">Settings → Browser</strong> and
						import valid cookies from a supported local browser profile. This
						copies a browser session into Zuse’s isolated built-in browser; it
						is not a cookie placed by zuse.sh and is not a website analytics
						mechanism.
					</p>
					<p className="mt-3">
						The import does not copy browsing history, bookmarks, autofill data,
						or saved passwords. Imported cookie values are kept in the desktop
						app’s encrypted local vault and can be restored after an app
						restart. Cookie values do not enter chat, renderer state, logs, or
						the browser settings interface. An agent must receive your explicit
						approval before using an imported signed-in session for a particular
						task and domain.
					</p>
					<p className="mt-3">
						Ordinary cookies, site storage, and cache in the built-in browser
						use an isolated session.{" "}
						<strong className="text-foreground">Clear imported</strong> removes
						the encrypted import record and any imported cookie whose value has
						not since been replaced by the site. A refreshed or rotated cookie
						can remain in the built-in browser session until you use{" "}
						<strong className="text-foreground">Clear browsing data</strong> to
						remove cookies, site storage, and cache from that built-in browser.
						Neither control changes the source browser.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Session and persistent storage
					</h2>
					<p className="mt-2">
						Session storage usually lasts until the relevant browser session
						ends. Persistent cookies or local storage remain until they expire
						or you, the browser, or the service removes them. We do not state
						exact periods here because they can depend on the browser,
						deployment, and purpose. You can clear website storage through your
						browser controls.
					</p>
					<p className="mt-3">
						For explicitly imported desktop cookies, Zuse preserves an expiry
						date when the source cookie provides one. Cookies without an expiry
						can remain in the encrypted local vault until you clear or replace
						the import. The imported copy is separate from the source browser’s
						copy.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Your browser controls
					</h2>
					<p className="mt-2">
						Most browsers let you block cookies, restrict third-party cookies,
						use private browsing, inspect stored values, and delete cookies or
						site data. The names and behavior of those controls differ by
						browser and device. Blocking all storage may affect appearance
						preferences or other requested features. Deleting cookies in your
						everyday browser does not automatically clear an imported copy held
						by the Zuse desktop app; use the app’s browser controls for that
						copy.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Do Not Track and Global Privacy Control
					</h2>
					<p className="mt-2">
						The current website does not advertise a separate Do Not Track (DNT)
						or Global Privacy Control (GPC) preference workflow. Because the
						marketing site currently has no advertising or website analytics
						program, there is no website analytics profile for these signals to
						opt you out of. If the site’s storage practice changes, we will
						update this policy and describe how those signals are handled.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Consent and choices
					</h2>
					<p className="mt-2">
						There is currently no cookie banner or cookie-preference center on
						the marketing website. You can use your browser’s storage controls
						and the website’s appearance setting to manage the browser state
						that exists today. If Zuse introduces non-essential website cookies
						or similar tracking technologies, this policy will be revised and
						the site will present an appropriate way to make the choices offered
						for that practice.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Linked and third-party services
					</h2>
					<p className="mt-2">
						The site links to services such as the Zuse source repository,
						community, releases, and social profiles. Those destinations may use
						cookies, storage, authentication sessions, or analytics under their
						own policies. Zuse does not control those technologies merely
						because the site links to them. Review the destination’s policy
						before signing in or sharing information there.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">
						Changes to this policy
					</h2>
					<p className="mt-2">
						We may update this page when the website, desktop browser, or
						storage practice changes. The effective date at the top will show
						when the current version was published. Check this page periodically
						if cookie behavior is important to you.
					</p>
				</section>

				<section>
					<h2 className="text-xl font-medium text-foreground">Questions</h2>
					<p className="mt-2">
						Questions or corrections about this policy can be raised through the
						public{" "}
						<Link
							href={GITHUB_URL}
							className="text-primary underline underline-offset-4"
						>
							Zuse repository
						</Link>{" "}
						or the{" "}
						<Link
							href={DISCORD_URL}
							className="text-primary underline underline-offset-4"
						>
							Zuse Discord community
						</Link>
						. These are the contact channels currently published by Zuse; this
						policy does not provide an unverified email address or mailing
						address.
					</p>
				</section>
			</div>
		</LegalPageShell>
	);
}
