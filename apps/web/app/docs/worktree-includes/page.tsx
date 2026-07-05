import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
  title: "Zuse Worktree File Includes",
  description: "Copy or link local files into Zuse worktrees.",
  path: "/docs/worktree-includes",
});

export default function WorktreeIncludesDocs() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-20 text-foreground">
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">Docs</p>
        <h1 className="text-4xl font-semibold">Worktree file includes</h1>
        <p className="text-muted-foreground">
          Use <code>file_include_globs</code> in{" "}
          <code>.zuse/settings.toml</code> for local files every worktree needs.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Behavior</h2>
        <p className="text-muted-foreground">
          Zuse links matching files from the main checkout into each new
          worktree at the same relative path. Existing worktree files are left
          untouched.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/30 p-4 text-sm">
          {`file_include_globs = ".env\\n.env.local\\napps/web/.env.local\\n"`}
        </pre>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Legacy file</h2>
        <p className="text-muted-foreground">
          A root <code>.worktreeinclude</code> file may still be read for
          compatibility, but new projects should use{" "}
          <code>.zuse/settings.toml</code>.
        </p>
      </section>
    </main>
  );
}
