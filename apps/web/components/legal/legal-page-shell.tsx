import Link from "next/link";
import type { ReactNode } from "react";

export function LegalPageShell({ children }: { readonly children: ReactNode }) {
	return (
		<main className="legal-document mx-auto min-h-screen max-w-3xl px-6 py-20 text-foreground">
			<Link href="/" className="text-sm text-primary">
				← Back to Zuse
			</Link>
			{children}
		</main>
	);
}

export function LegalSectionNav({
	label,
	links,
}: {
	readonly label: string;
	readonly links: ReadonlyArray<{
		readonly href: string;
		readonly label: string;
	}>;
}) {
	return (
		<nav
			aria-label={label}
			className="mt-8 border-y border-border py-4 text-sm text-muted-foreground"
		>
			<div className="flex flex-wrap gap-x-4 gap-y-2">
				{links.map((link) => (
					<a key={link.href} className="hover:text-foreground" href={link.href}>
						{link.label}
					</a>
				))}
			</div>
		</nav>
	);
}
