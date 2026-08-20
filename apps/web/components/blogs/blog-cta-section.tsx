import { Button } from "@/components/button";
import { Container } from "@/components/container";

export const BlogCtaSection = () => {
	return (
		<section>
			<Container className="flex items-center justify-center pt-30 pb-50">
				<div className="flex w-full max-w-200 flex-col gap-6">
					<span className="text-foreground -tracking-sm text-3xl leading-10 font-medium">
						Token max every coding agent from one desktop app.
					</span>
					<span className="-tracking-xs text-muted-foreground text-base leading-6 font-medium">
						Zuse (Beta) is for power users running Claude Code, Codex, Cursor,
						Gemini, Grok, OpenCode, and Kiro across real projects. Keep the
						agents busy, isolate the work, and review the diffs before anything
						lands.
					</span>
					<span className="-tracking-xs text-muted-foreground text-base leading-6 font-medium">
						It is local-first by design: chats in SQLite on disk, keys in the
						operating system credential store. Bring your own keys and use your
						existing agent subscriptions. Zuse Cloud is an optional, invite-only
						beta.
					</span>
					<div>
						<Button />
					</div>
				</div>
			</Container>
		</section>
	);
};
