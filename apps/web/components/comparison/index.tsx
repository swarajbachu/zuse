import { Container } from "@/components/container";
import { Header } from "@/components/header";
import { InfoCards, InfoCardsProps } from "@/components/comparison/info-cards";
import {
  ChipIcon,
  CubeIcon,
  DimondIcon,
  DocsIcon,
  DoorsOpenIcon,
  HandShakeIocn,
  HandsIcon,
  MessageIcon,
  MessageSend,
  NodeLines,
} from "@/components/icons/general";
import { ComparisonTabel, ComparisonData } from "@/components/comparison/comparison-tabel";
import { ComparisonAccordion } from "@/components/comparison/comparison-accordion";
import { Button } from "@/components/button";

const cardsData: InfoCardsProps[] = [
  {
    title: "Max out the tools you already have",
    description:
      "Run Claude Code, Codex, Cursor, Gemini, Grok, and OpenCode from one project-aware app.",
    icon: <DoorsOpenIcon />,
  },
  {
    title: "No token resale",
    description:
      "Use your own API keys or subscriptions. Zuse Alpha adds $0 markup to the model usage you run.",
    icon: <DocsIcon />,
  },
  {
    title: "Local-first control",
    description:
      "Chats and worktrees persist in local SQLite. Your keys live in the macOS Keychain, not our servers.",
    icon: <HandsIcon />,
  },
];

const comparisonData: ComparisonData[] = [
  {
    title: "Token maxing",
    zuse: "Multiple useful agent runs, visible in one workspace",
    traditional: "One terminal session at a time, or chaos",
    icon: <MessageIcon />,
  },
  {
    title: "Subscriptions",
    zuse: "Use the provider plans and keys you already pay for",
    traditional: "Pay another product to resell model credits",
    icon: <ChipIcon />,
  },
  {
    title: "Isolation",
    zuse: "A git worktree per serious chat, no clobbering",
    traditional: "Agents fighting over one working tree",
    icon: <CubeIcon />,
  },
  {
    title: "Reviewing changes",
    zuse: "Built-in diff pane and commit composer",
    traditional: "Terminal output plus memory",
    icon: <NodeLines />,
  },
  {
    title: "Permissions",
    zuse: "Smart policy with per-session overrides",
    traditional: "Blind --yolo or babysitting every prompt",
    icon: <HandShakeIocn />,
  },
  {
    title: "Context",
    zuse: "Readable tool calls, thinking, files, and diffs",
    traditional: "Raw text scrolling past in a buffer",
    icon: <MessageSend />,
  },
  {
    title: "Parallel work",
    zuse: "More attempts without losing reviewability",
    traditional: "More attempts means more cleanup",
    icon: <DimondIcon />,
  },
];

export const Comparison = () => {
  return (
    <section id="compare" className="w-full scroll-mt-24">
      <Container className="flex flex-col gap-15 py-20 md:py-30">
        <div className="flex flex-col gap-6">
          <Header>Token maxing without terminal chaos.</Header>
          <p className="text-muted-foreground max-w-3xl text-base leading-6 font-medium md:text-lg md:leading-7">
            The point is not more output. The point is more useful attempts,
            clearer branches, and fewer wasted subscriptions.
          </p>
          <div className="block lg:hidden">
            <Button />
          </div>
        </div>
        <div className="flex flex-col gap-6">
          {/* for desktop only */}
          <div className="bg-card border border-white/10 hidden w-full rounded-3xl lg:block">
            <ComparisonTabel cards={comparisonData} />
          </div>

          {/* for mobile and tablet */}
          <div className="block w-full lg:hidden">
            <ComparisonAccordion cards={comparisonData} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {cardsData.map((item) => (
              <InfoCards key={item.title} {...item} />
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
};
