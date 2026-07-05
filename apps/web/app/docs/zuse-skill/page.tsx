import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
  title: "Bundled Zuse Skill",
  description: "How the first-party Zuse skill is installed and used.",
  path: "/docs/zuse-skill",
});

export default function ZuseSkillDocs() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-20 text-foreground">
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">Docs</p>
        <h1 className="text-4xl font-semibold">Bundled Zuse skill</h1>
        <p className="text-muted-foreground">
          Zuse ships one first-party native skill for help with project setup,
          repository settings, worktrees, scripts, schemas, and troubleshooting.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Native providers</h2>
        <p className="text-muted-foreground">
          Zuse installs the skill for Claude and Codex, the providers with
          native skill discovery currently wired in Zuse.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/30 p-4 text-sm">
          {`~/.claude/skills/zuse/SKILL.md
~/.codex/skills/zuse/SKILL.md`}
        </pre>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Unsupported providers</h2>
        <p className="text-muted-foreground">
          Grok, OpenCode, Cursor, and Gemini do not receive injected fallback
          skill text. They can support this later when native provider skill
          surfaces are available in Zuse.
        </p>
      </section>
    </main>
  );
}
