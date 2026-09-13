import Link from "next/link";
import {
	LegalPageShell,
	LegalSectionNav,
} from "@/components/legal/legal-page-shell";
import { getSEO } from "@/lib/seo";
import { DISCORD_URL, GITHUB_URL } from "@/lib/site";

export const metadata = getSEO({
	title: "Accessibility Statement",
	description:
		"Zuse's accessibility intent, current product support, known limitations, and ways to report an accessibility issue.",
	path: "/accessibility",
});

export default function AccessibilityPage() {
	return (
		<LegalPageShell>
			<h1 className="mt-8 text-4xl font-semibold">Accessibility statement</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				Current as of September 9, 2026
			</p>
			<p className="mt-8 text-base leading-7 text-muted-foreground">
				Zuse wants its website, desktop app, and mobile app to be usable by as
				many people as possible, including people who use keyboards, screen
				readers, magnification, voice control, switch access, or other assistive
				technology. Accessibility is part of how we design and maintain the
				product, and we welcome reports that help us find barriers.
			</p>
			<p className="mt-2 text-base leading-7 text-muted-foreground">
				This is a description of current intent and observed product behavior.
				It is not a claim of WCAG or other accessibility conformance, an audit,
				certification, or complete screen-reader, browser, operating-system, or
				assistive-technology coverage. Some features are still changing,
				especially remote and Cloud Workspace features.
			</p>

			<LegalSectionNav
				label="Accessibility statement sections"
				links={[
					{ href: "#scope", label: "Scope and intent" },
					{ href: "#website", label: "Website" },
					{ href: "#desktop", label: "Desktop" },
					{ href: "#mobile", label: "Mobile" },
					{ href: "#limitations", label: "Known limitations" },
					{ href: "#feedback", label: "Feedback" },
					{ href: "#updates", label: "Updates" },
				]}
			/>

			<div className="mt-10 space-y-10 text-base leading-7 text-muted-foreground">
				<section id="scope">
					<h2 className="text-xl font-medium text-foreground">
						Scope and intent
					</h2>
					<p className="mt-2">
						This statement covers the public website at zuse.sh, the Zuse
						desktop application, and the Zuse mobile application. It also
						describes the boundaries of accessibility work where Zuse displays
						content from a connected provider, terminal, repository, or hosted
						environment. Those services and the content they return may have
						separate accessibility characteristics that Zuse cannot control.
					</p>
					<p className="mt-2">
						Our practical intent is to provide a clear reading order, meaningful
						labels and status information, keyboard and native interaction
						paths, visible focus, usable text alternatives where they are
						available, and appearance and motion choices that do not
						unnecessarily prevent use. The implementation is uneven across
						surfaces and is not a substitute for checking the particular
						workflow you rely on.
					</p>
				</section>

				<section id="website">
					<h2 className="text-xl font-medium text-foreground">Website</h2>
					<p className="mt-2">
						The website uses native headings, links, lists, main content,
						navigation, and footer regions in the pages and shared components.
						The small-screen navigation menu is a button with an accessible
						label and expanded-state information; the theme control is a labeled
						button. Icon-only links include labels, and decorative icons are
						hidden from the accessibility tree where appropriate.
					</p>
					<p className="mt-2">
						Interactive links and controls include visible focus styling. The
						download control exposes its{" "}
						<kbd className="font-mono text-foreground">D</kbd> keyboard shortcut
						to assistive technology as well as showing it visually. The site
						supports a light and dark appearance through its theme control. When
						a visitor&apos;s operating system requests reduced motion, the site
						disables smooth scrolling and selected decorative animations.
					</p>
					<p className="mt-2">
						These are implementation details, not a promise that every page,
						third-party embed, image, animation, color combination, zoom level,
						or browser combination is accessible. The public website has not
						been represented as having passed a formal accessibility review.
					</p>
				</section>

				<section id="desktop">
					<h2 className="text-xl font-medium text-foreground">
						Desktop application
					</h2>
					<p className="mt-2">
						The desktop interface is built from native web controls and shared
						UI primitives. Current code includes accessible names for many icon
						actions, status and alert announcements for some loading, error, and
						approval states, and focusable chat transcripts and pane regions.
						Permission requests expose actions such as allow and deny as
						controls; some of those actions also have keyboard paths.
					</p>
					<p className="mt-2">
						Desktop keybindings are configurable and include commands for
						opening projects and settings, switching chats and tabs, moving
						between panes, focusing the composer, toggling sidebars and the
						terminal, and saving or annotating files. Keyboard behavior can vary
						with your operating system, chosen keybindings, focused editor or
						terminal, and assistive technology. The desktop also observes an
						operating-system reduced-motion preference for motion-sensitive
						behavior in supported areas.
					</p>
					<p className="mt-2">
						The desktop is a dense coding workspace with resizable panes,
						editors, menus, dialogs, live updates, and provider-driven content.
						We have not verified every path with every screen reader,
						keyboard-only setup, text scaling setting, or platform accessibility
						service.
					</p>
				</section>

				<section id="mobile">
					<h2 className="text-xl font-medium text-foreground">
						Mobile application
					</h2>
					<p className="mt-2">
						The mobile app uses platform-native React Native and iOS controls in
						many interaction paths. Current controls include accessibility
						labels and roles for actions such as navigation, attachments,
						connection recovery, chat actions, message actions, question
						choices, and error dismissal. Some loading, error, and connection
						states are exposed as alerts or progress indicators, and text in
						relevant message and error views can be selected where the current
						component supports it.
					</p>
					<p className="mt-2">
						Colors use light and dark dynamic system values on supported
						platforms. Animated loading and presence indicators use the platform
						reduced-motion preference in the areas that implement it. Native
						touch targets and system menus are used in several mobile flows, but
						behavior depends on the platform, OS version, and the particular
						screen.
					</p>
					<p className="mt-2">
						This does not establish complete VoiceOver, TalkBack,
						switch-control, keyboard, or dynamic-type coverage. The mobile app
						may also display transcripts, diffs, images, diagrams, and
						terminal-related information whose accessibility depends on the
						content and the rendering path.
					</p>
				</section>

				<section id="limitations">
					<h2 className="text-xl font-medium text-foreground">
						Known limitations and content boundaries
					</h2>
					<p className="mt-2">
						Terminal output, command-line interfaces, code editors, syntax
						highlighting, and code diffs can be difficult to navigate or
						interpret with assistive technology. Virtualized lists, dense panes,
						live agent updates, focus changes, dialogs, and provider-specific
						controls may not announce or preserve context in the way you expect.
						Color, contrast, text scaling, zoom, pointer targets, and motion may
						also need improvement in particular views.
					</p>
					<p className="mt-2">
						Zuse can render or relay material from model providers,
						source-control services, terminals, repositories, browser sessions,
						remote machines, and Cloud Workspaces. Provider-generated text,
						code, images, diagrams, terminal output, and other third-party
						content may be inaccessible or change without notice. Zuse cannot
						promise to remediate accessibility barriers originating in those
						services or in content you or an agent choose to display.
					</p>
					<p className="mt-2">
						If a workflow is important to you, please consider keeping an
						alternate way to reach the same project or information. An
						accessibility barrier can also be specific to a browser, operating
						system, device, window size, provider, repository, or connection
						state, so those details help us understand what Zuse can address.
					</p>
				</section>

				<section id="feedback">
					<h2 className="text-xl font-medium text-foreground">
						Report an accessibility barrier
					</h2>
					<p className="mt-2">
						For a non-sensitive accessibility problem in Zuse, use the
						project&apos;s verified{" "}
						<a
							href={`${GITHUB_URL}/issues`}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary underline underline-offset-4"
						>
							GitHub Issues
						</a>{" "}
						page. General questions and feedback can also be shared in the
						official{" "}
						<a
							href={DISCORD_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary underline underline-offset-4"
						>
							Discord community
						</a>
						. Use only channels where you are comfortable sharing the details.
					</p>
					<p className="mt-2">
						A useful report includes the product surface (website, desktop, or
						mobile), page or screen, app and OS version, browser and assistive
						technology if relevant, input method, a short sequence of steps,
						what you expected, what happened, and whether the issue is
						repeatable. A redacted screenshot, recording, console message, or
						error text can help when it does not expose private content.
					</p>
					<p className="mt-2">
						Do not put passwords, API keys, access tokens, private repository
						content, personal data, pairing codes, unredacted transcripts, or
						other sensitive workspace material in a public issue or community
						channel. For a security concern, follow the private-reporting
						guidance in the project&apos;s{" "}
						<Link
							href="/security"
							className="text-primary underline underline-offset-4"
						>
							Security &amp; data practices
						</Link>{" "}
						page. Zuse does not publish a fixed response time or remediation
						timeline for accessibility reports.
					</p>
				</section>

				<section id="updates">
					<h2 className="text-xl font-medium text-foreground">
						Statement updates
					</h2>
					<p className="mt-2">
						We may update this statement as the website, desktop app, mobile
						app, connected services, and our understanding of accessibility
						change. The date at the top indicates the current version. Material
						changes may also be reflected in product documentation or release
						notes. The current statement describes known scope; it should not be
						read as a promise that any particular fix, feature, deadline, or
						level of support will be available.
					</p>
				</section>
			</div>
		</LegalPageShell>
	);
}
