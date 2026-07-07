import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
  title: "Zuse User Settings",
  description: "User-level Zuse settings, keybindings, and schema URLs.",
  path: "/docs/settings",
});

export default function SettingsDocs() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-20 text-foreground">
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">Docs</p>
        <h1 className="text-4xl font-semibold">User settings</h1>
        <p className="text-muted-foreground">
          Zuse stores user-level preferences in{" "}
          <code>~/.zuse/settings.json</code>
          and keybinding overrides in <code>~/.zuse/keybindings.json</code>.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Schemas</h2>
        <p className="text-muted-foreground">
          Editors can use these public schemas for validation and completion.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/30 p-4 text-sm">
          {`https://zuse.dev/schemas/settings.schema.json
https://zuse.dev/schemas/keybindings.schema.json`}
        </pre>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Repository settings</h2>
        <p className="text-muted-foreground">
          Team-shared project setup belongs in <code>.zuse/settings.toml</code>,
          not user settings.
        </p>
      </section>
    </main>
  );
}
