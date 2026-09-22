import Image from "next/image";
import type { ReactNode } from "react";

export function PageMasthead({
	eyebrow,
	title,
	description,
	artwork = "observatory",
}: {
	eyebrow: string;
	title: ReactNode;
	description?: string;
	artwork?: "observatory" | "pegasus" | "handoff";
}) {
	return (
		<header className="page-masthead">
			<Image
				src={`/brand/${artwork}-dither.webp`}
				alt=""
				width={480}
				height={480}
				sizes="464px"
				className="masthead-art"
			/>
			<div className="relative z-10 max-w-3xl">
				<p className="editorial-label">{eyebrow}</p>
				<h1 className="mt-5 text-[clamp(2.75rem,6vw,5rem)]">{title}</h1>
				{description && (
					<p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
						{description}
					</p>
				)}
			</div>
		</header>
	);
}
