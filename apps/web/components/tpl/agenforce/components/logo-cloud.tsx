import Image from "next/image";

const AGENTS = [
	{ name: "Claude Code", src: "/logos/claude.svg" },
	{ name: "Codex", src: "/logos/openai.svg" },
	{ name: "Cursor", src: "/logos/cursor.svg" },
	{ name: "Grok", src: "/logos/grok.svg" },
	{ name: "Gemini", src: "/logos/gemini.svg" },
	{ name: "OpenCode", src: "/logos/opencode.svg" },
	{ name: "Kiro", src: "/logos/kiro.svg" },
];

export const LogoCloud = () => {
	return (
		<section className="px-4 py-12 md:px-8 md:py-16">
			<h2 className="text-heading mx-auto max-w-xl text-center text-lg font-medium text-balance">
				Bring the subscriptions you already pay for.{" "}
				<span className="text-muted-foreground">
					Zuse orchestrates them — no token markup.
				</span>
			</h2>
			<div className="border-border bg-border mx-auto mt-9 grid max-w-5xl grid-cols-2 gap-px overflow-hidden rounded-xl border sm:grid-cols-7">
				{AGENTS.map((a) => (
					<div
						key={a.name}
						className="group bg-background relative flex min-h-28 flex-col items-center justify-center gap-3 overflow-hidden px-3 py-5 last:col-span-2 sm:last:col-span-1"
					>
						<span className="bg-primary/[0.04] absolute inset-0 translate-y-full transition-transform duration-200 ease-out group-hover:translate-y-0 motion-reduce:transition-none" />
						<span className="relative grid size-10 place-items-center rounded-lg bg-white shadow-sm ring-1 ring-black/5">
							<Image
								src={a.src}
								alt=""
								width={24}
								height={24}
								className="size-6 object-contain"
							/>
						</span>
						<span className="text-heading relative text-center text-xs font-medium">
							{a.name}
						</span>
					</div>
				))}
			</div>
		</section>
	);
};
