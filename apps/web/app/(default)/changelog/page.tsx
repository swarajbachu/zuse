import { Container } from "@/components/container";
import { PageMasthead } from "@/components/page-masthead";
import changelogData from "@/content/changelog.json";
import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
	title: "Change Log",
	description: "All notable Zuse product changes, grouped by release.",
	path: "/changelog",
});

type ChangeSection = {
	title: string;
	items: string[];
};

type ChangeRelease = {
	version: string;
	sections: ChangeSection[];
};

export default async function ChangelogPage() {
	const releases = changelogData as ChangeRelease[];

	return (
		<main className="w-full">
			<PageMasthead
				eyebrow="Release notes"
				title="Always in motion."
				description="The latest improvements, fixes, and additions to Zuse."
			/>
			<Container className="flex flex-col pb-24">
				<div className="grid gap-8">
					{releases.map((release) => (
						<article
							key={release.version}
							className="border-b border-dotted border-border py-12"
						>
							<div className="flex flex-col gap-8 md:grid md:grid-cols-[160px_1fr]">
								<h2 className="text-primary font-mono text-lg font-semibold">
									{release.version}
								</h2>
								<div className="grid gap-8">
									{release.sections.map((section) => (
										<section key={`${release.version}-${section.title}`}>
											<h3 className="text-heading font-mono text-xs font-semibold tracking-wide uppercase">
												{section.title}
											</h3>
											<ul className="mt-4 grid gap-3">
												{section.items.map((item) => (
													<li
														key={item}
														className="text-muted-foreground flex gap-3 text-sm leading-6"
													>
														<span className="bg-primary mt-2 size-1.5 shrink-0 rounded-full" />
														<span>{item}</span>
													</li>
												))}
											</ul>
										</section>
									))}
								</div>
							</div>
						</article>
					))}
				</div>
			</Container>
		</main>
	);
}
