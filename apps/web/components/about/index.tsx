import { Container } from "@/components/container";

const dream = [
  {
    title: "Open a repo and start three serious attempts",
    body: "One agent explores the feature, one fixes the bug, one cleans the tests. You are not waiting on a single thread.",
  },
  {
    title: "Use every subscription like it is meant to be used",
    body: "Claude Code, Codex, Cursor, Gemini, Grok, and OpenCode all stay available. Pick the best tool for the run.",
  },
  {
    title: "Ship only the work that survives review",
    body: "Each attempt can live in its own worktree with its own timeline and diff. More output does not mean less control.",
  },
];

export const AboutSection = () => {
  return (
    <section className="bg-natural-black text-natural-white w-full">
      <Container className="grid grid-cols-1 gap-10 py-20 md:py-30 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
        <div className="flex flex-col gap-5">
          <div className="text-primary text-sm font-semibold uppercase tracking-[0.08em]">
            The dream
          </div>
          <h2 className="text-4xl font-semibold tracking-tight md:text-5xl">
            Code all day. Keep the agents busy.
          </h2>
          <p className="text-muted-foreground text-base leading-6 font-medium md:text-lg md:leading-7">
            Zuse (Beta) is for people who want to become the kind of builder who can
            keep multiple projects moving, max out their AI subscriptions, and
            still know exactly what changed.
          </p>
        </div>

        <div className="grid gap-3">
          {dream.map((item, index) => (
            <div
              key={item.title}
              className="grid gap-4 rounded-2xl bg-white/[0.06] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] md:grid-cols-[48px_1fr] md:p-6"
            >
              <div className="flex size-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {index + 1}
              </div>
              <div>
                <h3 className="text-lg font-semibold tracking-tight text-natural-white">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm leading-5 text-natural-white/65 md:text-base md:leading-6">
                  {item.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
};
