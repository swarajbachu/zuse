import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
  title: "Zuse Repository Scripts",
  description: "Configure setup, run, and archive scripts for Zuse worktrees.",
  path: "/docs/scripts",
});

export default function ScriptsDocs() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-20 text-foreground">
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">Docs</p>
        <h1 className="text-4xl font-semibold">Repository scripts</h1>
        <p className="text-muted-foreground">
          Scripts in <code>.zuse/settings.toml</code> run from the worktree
          directory and receive Zuse environment variables.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Fields</h2>
        <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/30 p-4 text-sm">
          {`[scripts]
setup = "bun install"
run = "bun run dev"
archive = "rm -rf node_modules .next"
auto_run_after_setup = false`}
        </pre>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Environment</h2>
        <p className="text-muted-foreground">
          Zuse passes <code>ZUSE_ROOT_PATH</code>,{" "}
          <code>ZUSE_WORKTREE_PATH</code>, <code>ZUSE_WORKTREE_ID</code>, and
          values from the <code>[environment_variables]</code> table.
        </p>
      </section>
    </main>
  );
}
