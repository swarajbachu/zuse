import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
  title: "Zuse Repository Settings",
  description: "Configure .zuse/settings.toml for shared Zuse project setup.",
  path: "/docs/repository-settings",
});

export default function RepositorySettingsDocs() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-20 text-foreground">
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">Docs</p>
        <h1 className="text-4xl font-semibold">Repository settings</h1>
        <p className="text-muted-foreground">
          Commit <code>.zuse/settings.toml</code> when setup should be shared by
          everyone working in a repository.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Example</h2>
        <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/30 p-4 text-sm">
          {`# Zuse repository settings. Commit this file to share setup with your team.
# Add files below that should be linked from the main checkout into every Zuse worktree.
schemaVersion = 1
autoCreateWorktree = false
archiveRemoveWorktree = false

file_include_globs = [
  ".env",
  ".env.local",
  ".env.*.local",
]

[scripts]
setup = "bun install"
run = "bun run dev"
archive = ""
auto_run_after_setup = false

[environment_variables]
NODE_ENV = "development"`}
        </pre>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Schema</h2>
        <p className="text-muted-foreground">
          Use{" "}
          <code>https://zuse.dev/schemas/repository-settings.schema.json</code>
          for editor validation.
        </p>
      </section>
    </main>
  );
}
