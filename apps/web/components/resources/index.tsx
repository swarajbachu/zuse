import { Container } from "@/components/container";
import { Header } from "@/components/header";
import { BlogCard, CardData } from "@/components/resources/blog-card";
import { FilterBadge } from "@/components/resources/filter-badge";

const data: CardData[] = [
  {
    title: "Run six coding agents side by side",
    description:
      "Claude Code, Codex, Cursor, Gemini, Grok, and OpenCode in one window. Switch providers without losing context.",
    time: "5 min read",
    image: "/assets/blog-preview-agents-clean.svg",
    href: "/blog/run-six-agents-side-by-side",
  },
  {
    title: "Bring your own keys",
    description:
      "Your API keys stay in the macOS Keychain. Zuse (Beta) is not a reseller and never marks up your model usage.",
    time: "4 min read",
    image: "/assets/blog-preview-keys-clean.svg",
    href: "/blog/bring-your-own-keys",
  },
  {
    title: "Git worktrees for every chat",
    description:
      "Each chat gets an isolated working tree, so parallel agents never clobber each other's changes.",
    time: "5 min read",
    image: "/assets/blog-preview-worktrees-clean.svg",
    href: "/blog/git-worktrees-for-every-chat",
  },
  {
    title: "Sub-agent delegation to cut cost",
    description:
      "Let a lead agent spawn cheaper models for the grunt work, then keep the expensive model for the hard parts.",
    time: "5 min read",
    image: "/assets/blog-preview-subagents-clean.svg",
    href: "/blog/sub-agent-delegation",
  },
  {
    title: "Local-first by design",
    description:
      "SQLite on disk, keys in the Keychain, no account required. Your work stays on your machine.",
    time: "4 min read",
    image: "/assets/blog-preview-local-clean.svg",
    href: "/blog/local-first-by-design",
  },
  {
    title: "Zuse Alpha is now in public alpha",
    description:
      "A chat-first macOS app that wraps every coding agent CLI in one project-aware workspace. Free during alpha.",
    time: "4 min read",
    image: "/assets/blog-preview-alpha-clean.svg",
    href: "/blog/memoize-public-alpha",
  },
];

export const Resources = () => {
  return (
    <section className="w-full">
      <Container className="flex flex-col gap-15 pt-30 pb-20">
        <Header>Resources</Header>
        <div className="flex w-full flex-col gap-8">
          <div className="flex gap-2 flex-wrap w-full">
            <FilterBadge isSelected>All</FilterBadge>
            <FilterBadge>Agents</FilterBadge>
            <FilterBadge>Local-first</FilterBadge>
            <FilterBadge>Worktrees</FilterBadge>
            <FilterBadge>BYOK</FilterBadge>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {data.map((card, index) => (
              <BlogCard key={index} card={card} />
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
};
