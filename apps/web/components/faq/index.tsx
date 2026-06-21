import React from "react";
import { Container } from "@/components/container";
import { Header } from "@/components/header";
import { CTACard } from "@/components/faq/cta-card";
import {
  AccordionContent,
  AccordionTrigger,
  Accordion,
  AccordionItem,
} from "@/components/ui/accordion";
import { GITHUB_URL } from "@/lib/site";
import Link from "next/link";

const data = [
  {
    question: "What do you mean by token maxing?",
    answer:
      "Token maxing means using the model access you already pay for on more real work: parallel feature attempts, bug fixes, refactors, and reviews. memoize makes that sane by keeping each run visible, isolated, and reviewable.",
  },
  {
    question: "Who is memoize for?",
    answer:
      "memoize is for developers who want to become power users: people trying to code all day, keep multiple projects moving, max out their AI subscriptions, and still review exactly what ships.",
  },
  {
    question: "Which agents are supported?",
    answer:
      "memoize wraps six coding agent CLIs in one workspace: Claude Code, Codex, Cursor, Gemini, Grok, and OpenCode. You can run them side by side and switch providers without leaving the app.",
  },
  {
    question: "Do I need my own API keys or subscriptions?",
    answer:
      "Yes. memoize is bring your own keys. You plug in your own provider keys or subscriptions, and memoize talks to them directly. It never resells tokens and adds $0 markup, so you only pay the agent providers.",
  },
  {
    question: "Is my code or data sent anywhere?",
    answer:
      "No. memoize is local-first. Your chats and history live in a SQLite database on your machine, and your API keys are stored in the macOS Keychain. Your code only goes to the agent providers you configure, the same as running their CLIs yourself.",
  },
  {
    question: "Is it macOS only?",
    answer:
      "For now, yes. memoize is a native macOS desktop app and ships as a universal build for both Apple Silicon and Intel. Other platforms may come later.",
  },
  {
    question: "How much does it cost?",
    answer:
      "memoize is free while it is in public alpha. You only pay for the agent usage on your own keys. Paid Pro and Team plans are planned for later, but the alpha is free.",
  },
  {
    question: "Can I run multiple agents at once?",
    answer:
      "Yes. You can run several agents in parallel, each in its own chat with its own git worktree, so their changes stay isolated. Review and commit each one from the PR and Changes pane.",
  },
  {
    question: "What is sub-agent delegation?",
    answer:
      "A lead agent can spawn sub-agents to handle parts of a task, including cheaper models for the simpler work. That keeps the expensive model focused on the hard parts and lowers your overall token cost.",
  },
];

export const FAQ = () => {
  return (
    <section id="faq" className="w-full scroll-mt-24">
      <Container className="grid grid-cols-1 gap-15 py-20 md:py-30 lg:grid-cols-2">
        <div className="flex flex-col gap-15 pt-8">
          <div className="flex flex-col gap-4">
            <Header>Questions power users ask first</Header>
            <div className="-tracking-xs text-muted-foreground text-base leading-6 font-medium">
              More questions? See the project on{" "}
              <Link
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-3"
              >
                GitHub
              </Link>
              .
            </div>
          </div>
          <CTACard />
        </div>
        <div className="h-full w-full">
          <Accordion defaultValue={[`${data[0].question}-0`]}>
            {data.map((item, index) => (
              <React.Fragment key={`${item.question}-${index}`}>
                <AccordionItem
                  value={`${item.question}-${index}`}
                  className="py-8"
                >
                  <AccordionTrigger className="-tracking-xs text-foreground text-base leading-6 font-medium">
                    {item.question}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    {item.answer}
                  </AccordionContent>
                </AccordionItem>
                {data.length - 1 !== index && (
                  <div className="bg-white/10 h-px w-full" />
                )}
              </React.Fragment>
            ))}
          </Accordion>
        </div>
      </Container>
    </section>
  );
};
