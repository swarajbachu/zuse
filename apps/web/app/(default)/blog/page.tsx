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
export default function BlogIndexPage() {
	const posts = blog
		.getPages()
		.toSorted((a, b) => b.data.date.getTime() - a.data.date.getTime());
	const [featured, ...rest] = posts;
	const notes = posts.filter((post) => post.data.category === "Note");
	const guides = posts.filter(
		(post) => post.data.category === "Guide" && post.url !== featured?.url,
	);
	return (
		<main className="journal-index">
			<header className="journal-masthead">
				<p className="editorial-label">From the people building Zuse</p>
				<h1 className="mt-4 text-[clamp(3rem,6vw,5rem)]">
					The <span className="heading-accent text-primary">Journal.</span>
				</h1>
				<p className="mt-5 max-w-lg text-sm leading-6 text-muted-foreground">
					Practical guides, release notes, and engineering journals about open
					source cloud agents.
				</p>
				<p className="mt-4 text-sm">
					<Link
						href="/blog/open-source-cloud-agents"
						className="text-primary underline underline-offset-4"
					>
						Start here: a guide to open source cloud agents
					</Link>
				</p>
				<nav
					aria-label="Journal sections"
					className="mt-7 flex gap-6 font-mono text-[11px] uppercase tracking-wider"
				>
					<a href="#latest" className="hover:text-primary">
						Latest
					</a>
					<a href="#guides" className="hover:text-primary">
						Guides
					</a>
					<a href="#notes" className="hover:text-primary">
						Notes
					</a>
				</nav>
			</header>
			<div className="journal-grid">
				<section
					id="latest"
					className="journal-column journal-latest scroll-mt-20"
				>
					<h2 className="journal-column-label font-mono">Latest</h2>
					{featured && (
						<Link href={featured.url} className="journal-feature group">
							{featured.data.previewImage && (
								<Image
									src={featured.data.previewImage}
									alt=""
									width={720}
									height={440}
									sizes="(max-width: 1023px) 100vw, 560px"
									priority
									className="aspect-[1.7] w-full rounded-lg object-cover"
								/>
							)}
							<div className="journal-feature-caption">
								<p className="editorial-label">
									Featured / {featured.data.category}
								</p>
								<h3 className="mt-3 text-3xl group-hover:text-primary">
									{featured.data.title}
								</h3>
								<p className="mt-3 text-sm leading-6 text-muted-foreground">
									{featured.data.description}
								</p>
							</div>
						</Link>
					)}
					{rest.slice(0, 4).map((post) => (
						<Link
							href={post.url}
							key={post.url}
							className="journal-feed-row group"
						>
							<div className="flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
								<time dateTime={post.data.date.toISOString()}>
									{dateLabel(post.data.date)}
								</time>
								<span className="text-primary">{post.data.category}</span>
							</div>
							<h3 className="mt-3 text-2xl group-hover:text-primary">
								{post.data.title}
							</h3>
							<p className="mt-3 text-sm leading-6 text-muted-foreground">
								{post.data.description}
							</p>
						</Link>
					))}
					{rest.length > 4 && (
						<details className="journal-archive">
							<summary className="cursor-pointer py-5 font-mono text-[11px] text-muted-foreground hover:text-primary">
								Earlier stories ({rest.length - 4})
							</summary>
							{rest.slice(4).map((post) => (
								<Link
									key={post.url}
									href={post.url}
									className="flex items-baseline justify-between gap-4 border-t border-dotted border-border py-4 text-sm hover:text-primary"
								>
									<span>{post.data.title}</span>
									<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
										{post.data.category}
									</span>
								</Link>
							))}
						</details>
					)}
				</section>
				<aside id="notes" className="journal-column journal-notes scroll-mt-20">
					<h2 className="journal-column-label font-mono">Notes</h2>
					{notes.map((post) => (
						<Link href={post.url} key={post.url} className="journal-note group">
							<time
								dateTime={post.data.date.toISOString()}
								className="font-mono text-[10px] uppercase text-muted-foreground"
							>
								{dateLabel(post.data.date)}
							</time>
							<h3 className="mt-3 text-xl group-hover:text-primary">
								{post.data.title}
							</h3>
							<p className="mt-2 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
								{post.data.description}
							</p>
						</Link>
					))}
					<div className="journal-side-footer">
						<p className="editorial-label">Open by design</p>
						<Link
							href="https://github.com/swarajbachu/zuse"
							className="mt-4 inline-flex items-center gap-2 text-sm hover:text-primary"
						>
							Explore the source <ArrowUpRight size={14} />
						</Link>
					</div>
				</aside>
				<aside
					id="guides"
					className="journal-column journal-guides scroll-mt-20"
				>
					<h2 className="journal-column-label font-mono">Guides</h2>
					{guides.map((post) => (
						<Link
							href={post.url}
							key={post.url}
							className="journal-guide group"
						>
							{post.data.previewImage && (
								<Image
									src={post.data.previewImage}
									alt=""
									width={320}
									height={220}
									sizes="(max-width: 1023px) 100vw, 240px"
									className="aspect-[1.5] w-full rounded-lg object-cover"
								/>
							)}
							<h3 className="mt-3 text-xl group-hover:text-primary">
								{post.data.title}
							</h3>
							<p className="mt-2 font-mono text-[10px] text-muted-foreground">
								{post.data.timeToRead}
							</p>
						</Link>
					))}
					<Link
						href="https://docs.zuse.sh"
						className="journal-side-footer inline-flex items-center gap-2 text-sm text-primary"
					>
						All documentation <ArrowUpRight size={14} />
					</Link>
				</aside>
			</div>
		</main>
	);
}
