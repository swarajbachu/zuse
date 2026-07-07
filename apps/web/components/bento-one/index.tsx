import { Container } from "@/components/container";
import { Header } from "@/components/header";

const features = [
  {
    title: "Run more than one useful attempt",
    body: "Start separate agents for a feature, a bug, and a refactor without turning the repo into one shared scratchpad.",
  },
  {
    title: "Use the right subscription for the job",
    body: "Keep Claude Code, Codex, Cursor, Gemini, Grok, and OpenCode available from one project surface.",
  },
  {
    title: "Keep every attempt reviewable",
    body: "A serious chat can get its own worktree, branch, timeline, and diff so you can decide what deserves to land.",
  },
  {
    title: "Stay local and keep the margin",
    body: "Bring your own keys. Chats stay in SQLite, keys stay in Keychain, and Zuse Alpha adds no token markup.",
  },
];

export const BentoOne = () => {
  return (
    <Container id="features" className="flex scroll-mt-24 flex-col gap-15 py-4">
      <div className="flex max-w-3xl flex-col gap-4">
        <Header>Built for devs who run agents all day.</Header>
        <p className="text-muted-foreground text-base leading-6 font-medium md:text-lg md:leading-7">
          Token maxing is not burning context for fun. It is keeping paid agents
          working on real branches while you stay in control of what ships.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {features.map((feature, index) => (
          <div
            key={feature.title}
            className="rounded-2xl bg-card p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] md:p-8"
          >
            <div className="flex size-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              {index + 1}
            </div>
            <h3 className="mt-8 text-xl font-semibold tracking-tight text-foreground">
              {feature.title}
            </h3>
            <p className="mt-3 text-base leading-6 text-muted-foreground">
              {feature.body}
            </p>
          </div>
        ))}
      </div>
    </Container>
  );
};
