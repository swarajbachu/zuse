import { Callout as FumadocsCallout } from "fumadocs-ui/components/callout";
import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import {
	Step as FumadocsStep,
	Steps as FumadocsSteps,
} from "fumadocs-ui/components/steps";
import Image from "next/image";
import type { ReactNode } from "react";
import { FEATURES, SURFACES, type Surface } from "../data/features";

const labelFromPath = (value: string) =>
	value
		.replace(/^\//u, "")
		.split("/")
		.at(-1)
		?.replace(/-/gu, " ")
		.replace(/\b\w/gu, (letter) => letter.toUpperCase()) ?? value;

export function Callout({
	title = "Good to know",
	children,
}: {
	title?: string;
	children: ReactNode;
}) {
	return <FumadocsCallout title={title}>{children}</FumadocsCallout>;
}

export function Warning({
	title = "Before you continue",
	children,
}: {
	title?: string;
	children: ReactNode;
}) {
	return (
		<FumadocsCallout type="warn" title={title}>
			{children}
		</FumadocsCallout>
	);
}

export function SecurityNote({
	title = "Security",
	children,
}: {
	title?: string;
	children: ReactNode;
}) {
	return (
		<FumadocsCallout type="idea" title={title}>
			{children}
		</FumadocsCallout>
	);
}

export function Troubleshooting({
	title = "If this does not work",
	children,
}: {
	title?: string;
	children: ReactNode;
}) {
	return (
		<FumadocsCallout type="warning" title={title}>
			{children}
		</FumadocsCallout>
	);
}

export function Command({ children }: { children: ReactNode }) {
	return (
		<DynamicCodeBlock
			lang="bash"
			code={String(children)}
			codeblock={{ title: "Terminal" }}
		/>
	);
}

export function GuideHero({
	label,
	children,
}: {
	label?: string;
	children: ReactNode;
}) {
	return (
		<section className="guide-hero">
			{label ? <span>{label}</span> : null}
			<div>{children}</div>
		</section>
	);
}

export function Workflow({ children }: { children: ReactNode }) {
	return <FumadocsSteps>{children}</FumadocsSteps>;
}

export function Step({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<FumadocsStep>
			<h3>{title}</h3>
			{children}
		</FumadocsStep>
	);
}

export function ProductFrame({
	title = "Zuse",
	children,
}: {
	title?: string;
	children: ReactNode;
}) {
	return (
		<figure className="product-frame">
			<figcaption>
				<span className="product-frame-dot"></span>
				{title}
			</figcaption>
			<div>{children}</div>
		</figure>
	);
}

export function Screenshot({
	src,
	alt,
	caption,
}: {
	src: string;
	alt: string;
	caption?: string;
}) {
	return (
		<figure className="docs-screenshot">
			<Image src={src} alt={alt} width={1600} height={1000} />
			{caption ? <figcaption>{caption}</figcaption> : null}
		</figure>
	);
}

export function Hotspot({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<span className="hotspot">
			<span>{label}</span>
			{children}
		</span>
	);
}

export function CommandTabs({ children }: { children: ReactNode }) {
	return <div className="command-tabs">{children}</div>;
}

export function CodeDiff({ children }: { children: ReactNode }) {
	return <div className="code-diff">{children}</div>;
}

export function FileTree({ children }: { children: ReactNode }) {
	return <div className="file-tree">{children}</div>;
}

export function SchemaTable({ children }: { children: ReactNode }) {
	return <div className="schema-table">{children}</div>;
}

export function PlatformBadge({ children }: { children: ReactNode }) {
	return <span className="meta-chip">{children}</span>;
}

export function ProviderBadge({ children }: { children: ReactNode }) {
	return <span className="meta-chip meta-chip-provider">{children}</span>;
}

export function Availability({
	state = "supported",
}: {
	state?: "supported" | "partial" | "host";
}) {
	return (
		<span className={`availability availability-${state}`}>
			{state === "host"
				? "Host"
				: state === "partial"
					? "Partial"
					: "Supported"}
		</span>
	);
}

export function CapabilityMatrix({
	features,
}: {
	features?: ReadonlyArray<keyof typeof FEATURES>;
}) {
	const rows = (features ?? Object.keys(FEATURES)) as ReadonlyArray<
		keyof typeof FEATURES
	>;
	return (
		<div className="capability-table-wrap">
			<table className="capability-table">
				<thead>
					<tr>
						<th>Capability</th>
						{SURFACES.map((surface) => (
							<th key={surface}>{surface.replace("-", " ")}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((key) => {
						const feature = FEATURES[key];
						return (
							<tr key={key}>
								<th>
									<strong>{feature.title}</strong>
									<span>{feature.description}</span>
								</th>
								{SURFACES.map((surface) => {
									const state = feature.surfaces[surface as Surface];
									return (
										<td key={surface}>
											{state ? (
												<Availability state={state} />
											) : (
												<span title="Not available">—</span>
											)}
										</td>
									);
								})}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

export function ArchitectureDiagram({ children }: { children: ReactNode }) {
	return <figure className="architecture-diagram">{children}</figure>;
}

export function Prerequisites({ links }: { links: ReadonlyArray<string> }) {
	if (links.length === 0) return null;
	return (
		<aside className="link-panel">
			<span>Before you start</span>
			<ul>
				{links.map((href) => (
					<li key={href}>
						<a href={href}>{labelFromPath(href)}</a>
					</li>
				))}
			</ul>
		</aside>
	);
}

export function RelatedPages({ links }: { links: ReadonlyArray<string> }) {
	if (links.length === 0) return null;
	return (
		<aside className="link-panel">
			<span>Related documentation</span>
			<ul>
				{links.map((href) => (
					<li key={href}>
						<a href={href}>{labelFromPath(href)}</a>
					</li>
				))}
			</ul>
		</aside>
	);
}

export function NextStep({ href, label }: { href: string; label: string }) {
	return (
		<a className="next-step" href={href}>
			<span>Continue</span>
			<strong>{label}</strong>
			<span aria-hidden="true">→</span>
		</a>
	);
}

export const mdxComponents = {
	GuideHero,
	Workflow,
	Step,
	ProductFrame,
	Screenshot,
	Hotspot,
	Command,
	CommandTabs,
	CodeDiff,
	FileTree,
	SchemaTable,
	CapabilityMatrix,
	PlatformBadge,
	ProviderBadge,
	Availability,
	Callout,
	Warning,
	SecurityNote,
	Troubleshooting,
	ArchitectureDiagram,
	RelatedPages,
	Prerequisites,
	NextStep,
};
