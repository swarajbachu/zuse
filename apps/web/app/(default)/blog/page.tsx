import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { getSEO } from "@/lib/seo";
import { blog } from "@/lib/source";

export const metadata = getSEO({
	title: "Open Source Cloud Agents: Guides and Journal",
	description:
		"Guides to open source cloud agents, Zuse release notes, and engineering journals on cloud workspaces, parallel coding, and reliable task recovery.",
	path: "/blog",
});
const dateLabel = (date: Date) =>
	date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
const LATEST_COUNT = 6;
export default function BlogIndexPage() {
	const posts = blog
		.getPages()
		.toSorted((a, b) => b.data.date.getTime() - a.data.date.getTime());
	const [featured, ...rest] = posts;
	const latest = rest.slice(0, LATEST_COUNT);
	const earlier = rest.slice(LATEST_COUNT);
	const notes = posts.filter((post) => post.data.category === "Note");
	const guides = posts.filter(
		(post) => post.data.category === "Guide" && post.url !== featured?.url,
	);
	const sections = [
		{ href: "#latest", label: "Latest", count: null },
		{ href: "#guides", label: "Guides", count: guides.length },
		{ href: "#notes", label: "Notes", count: notes.length },
	];
	return (
		<main className="journal-index">
			<header className="journal-masthead">
				<p className="editorial-label">From the people building Zuse</p>
				<h1 className="mt-5 text-[clamp(3rem,6vw,5rem)] leading-none">
					The <span className="heading-accent text-primary">Journal.</span>
				</h1>
				<p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground">
					Practical guides, release notes, and engineering journals about open
					source cloud agents.
				</p>
				<p className="mt-4 text-sm">
					<Link
						href="/blog/open-source-cloud-agents"
						className="inline-flex items-center gap-1.5 text-primary underline underline-offset-4"
					>
						Start here: a guide to open source cloud agents
						<ArrowUpRight size={14} aria-hidden />
					</Link>
				</p>
				<nav aria-label="Journal sections" className="journal-tabs">
					{sections.map((section) => (
						<a key={section.href} href={section.href} className="journal-tab">
							{section.label}
							{section.count !== null && (
								<span className="journal-tab-count">{section.count}</span>
							)}
						</a>
					))}
				</nav>
			</header>

			<section id="latest" className="journal-section scroll-mt-20">
				<h2 className="journal-section-label font-mono">Latest</h2>
				{featured && (
					<Link href={featured.url} className="journal-feature group">
						{featured.data.previewImage && (
							<Image
								src={featured.data.previewImage}
								alt=""
								width={960}
								height={600}
								sizes="(max-width: 1023px) 100vw, 640px"
								priority
								className="journal-feature-image aspect-[1.6] w-full rounded-xl object-cover"
							/>
						)}
						<div className="journal-feature-caption">
							<p className="editorial-label">
								Featured / {featured.data.category}
							</p>
							<h3 className="mt-4 text-[clamp(1.875rem,3.2vw,2.75rem)] leading-[1.1] group-hover:text-primary">
								{featured.data.title}
							</h3>
							<p className="mt-4 line-clamp-3 text-base leading-7 text-muted-foreground">
								{featured.data.description}
							</p>
							<p className="mt-6 flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
								<time dateTime={featured.data.date.toISOString()}>
									{dateLabel(featured.data.date)}
								</time>
								{featured.data.timeToRead && (
									<span>{featured.data.timeToRead}</span>
								)}
							</p>
						</div>
					</Link>
				)}
				{latest.length > 0 && (
					<div className="journal-card-grid">
						{latest.map((post) => (
							<Link
								href={post.url}
								key={post.url}
								className="journal-card group"
							>
								{post.data.previewImage && (
									<Image
										src={post.data.previewImage}
										alt=""
										width={480}
										height={300}
										sizes="(max-width: 767px) 100vw, (max-width: 1023px) 50vw, 360px"
										className="mb-5 hidden aspect-[1.6] w-full rounded-lg object-cover md:block"
									/>
								)}
								<p className="flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
									<time dateTime={post.data.date.toISOString()}>
										{dateLabel(post.data.date)}
									</time>
									<span className="text-primary">{post.data.category}</span>
								</p>
								<h3 className="mt-3 text-xl leading-snug group-hover:text-primary">
									{post.data.title}
								</h3>
								<p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
									{post.data.description}
								</p>
							</Link>
						))}
					</div>
				)}
				{earlier.length > 0 && (
					<details className="journal-archive">
						<summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:text-primary">
							Earlier stories ({earlier.length})
						</summary>
						<div className="mt-4">
							{earlier.map((post) => (
								<Link
									key={post.url}
									href={post.url}
									className="flex items-baseline justify-between gap-4 py-3 text-sm hover:text-primary"
								>
									<span>{post.data.title}</span>
									<span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
										{post.data.category}
									</span>
								</Link>
							))}
						</div>
					</details>
				)}
			</section>

			<div className="journal-lists">
				<section id="guides" className="journal-section scroll-mt-20">
					<h2 className="journal-section-label font-mono">Guides</h2>
					<div className="journal-guide-list">
						{guides.map((post) => (
							<Link
								href={post.url}
								key={post.url}
								className="journal-guide group"
							>
								<h3 className="text-lg leading-snug group-hover:text-primary">
									{post.data.title}
								</h3>
								<p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
									{post.data.description}
								</p>
								{post.data.timeToRead && (
									<p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
										{post.data.timeToRead}
									</p>
								)}
							</Link>
						))}
					</div>
					<Link
						href="https://docs.zuse.sh"
						className="mt-8 inline-flex items-center gap-2 text-sm text-primary"
					>
						All documentation <ArrowUpRight size={14} />
					</Link>
				</section>
				<aside id="notes" className="journal-section scroll-mt-20">
					<h2 className="journal-section-label font-mono">Notes</h2>
					<div className="journal-note-list">
						{notes.map((post) => (
							<Link
								href={post.url}
								key={post.url}
								className="journal-note group"
							>
								<time
									dateTime={post.data.date.toISOString()}
									className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
								>
									{dateLabel(post.data.date)}
								</time>
								<h3 className="mt-2 text-lg leading-snug group-hover:text-primary">
									{post.data.title}
								</h3>
								<p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
									{post.data.description}
								</p>
							</Link>
						))}
					</div>
					<div className="mt-8">
						<p className="editorial-label">Open by design</p>
						<Link
							href="https://github.com/swarajbachu/zuse"
							className="mt-3 inline-flex items-center gap-2 text-sm hover:text-primary"
						>
							Explore the source <ArrowUpRight size={14} />
						</Link>
					</div>
				</aside>
			</div>
		</main>
	);
}
