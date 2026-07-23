import Link from "next/link";

export default function PrivacyPage() {
	return (
		<main className="mx-auto min-h-screen max-w-3xl px-6 py-20 text-foreground">
			<Link href="/" className="text-sm text-primary">
				← Back to Zuse Alpha
			</Link>
			<h1 className="mt-8 text-4xl font-semibold">Privacy policy</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				Updated July 22, 2026
			</p>

			<div className="mt-10 space-y-8 text-base leading-7 text-muted-foreground">
				<section>
					<h2 className="text-xl font-medium text-foreground">
						Local work stays local
					</h2>
					<p className="mt-2">
						Chats, project data, and settings remain on your devices. Model
						requests go to the provider you choose. Zuse Alpha does not upload
						prompts, responses, reasoning, source code, commands, tool contents,
						file or repository names, paths, URLs, branches, titles, diagnostics
						contents, account details, credentials, tokens, or error stacks for
						analytics.
					</p>
				</section>
				<section>
					<h2 className="text-xl font-medium text-foreground">
						Usage analytics
					</h2>
					<p className="mt-2">
						Desktop and mobile usage analytics are on by default. We collect
						pseudonymous events about app activity, screens and stable control
						identifiers, feature use, model and provider choices, aggregated
						token and cost totals, active time, connection outcomes,
						performance, and sanitized reliability errors. Standard geographic
						enrichment may infer a general location from the network request.
						The marketing website does not use this product analytics system.
					</p>
				</section>
				<section>
					<h2 className="text-xl font-medium text-foreground">
						Identity and retention
					</h2>
					<p className="mt-2">
						Signed-out activity uses a random installation identity. Signed-in
						activity uses a one-way namespaced hash of the account ID so usage
						across your devices can be understood without sending the account ID
						itself. Signing out, resetting the app, or deleting your account
						creates a fresh anonymous identity. Previously collected
						pseudonymous aggregate history is retained.
					</p>
				</section>
				<section>
					<h2 className="text-xl font-medium text-foreground">Your choice</h2>
					<p className="mt-2">
						Turn collection off at any time in desktop or mobile Settings under
						“Share usage analytics.” The change takes effect immediately and
						pending desktop analytics are deleted. We do not use autocapture or
						session replay.
					</p>
				</section>
			</div>
		</main>
	);
}
