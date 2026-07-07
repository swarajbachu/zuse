import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
  title: "Zuse Schema URLs",
  description: "Public JSON Schemas for Zuse settings files.",
  path: "/docs/schemas",
});

export default function SchemaDocs() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-20 text-foreground">
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">Docs</p>
        <h1 className="text-4xl font-semibold">Schema URLs</h1>
        <p className="text-muted-foreground">
          Zuse publishes stable schemas for editor validation and agent
          guidance.
        </p>
      </header>

      <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/30 p-4 text-sm">
        {`https://zuse.dev/schemas/settings.schema.json
https://zuse.dev/schemas/repository-settings.schema.json
https://zuse.dev/schemas/keybindings.schema.json`}
      </pre>
    </main>
  );
}
