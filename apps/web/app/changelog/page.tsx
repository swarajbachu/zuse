import { readFile } from "node:fs/promises";
import path from "node:path";

import { Container } from "@/components/container";
import { Header } from "@/components/header";
import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
  title: "Change Log",
  description: "All notable memoize product changes, grouped by release.",
  path: "/changelog",
});

type ChangeSection = {
  title: string;
  items: string[];
};

type ChangeRelease = {
  version: string;
  sections: ChangeSection[];
};

async function getChangelog(): Promise<ChangeRelease[]> {
  const changelogPath = path.join(process.cwd(), "..", "..", "CHANGELOG.md");
  const source = await readFile(changelogPath, "utf8");
  const releases: ChangeRelease[] = [];
  let currentRelease: ChangeRelease | null = null;
  let currentSection: ChangeSection | null = null;

  for (const line of source.split(/\r?\n/)) {
    const releaseMatch = line.match(/^## \[([^\]]+)\]/);
    if (releaseMatch) {
      if (currentRelease) releases.push(currentRelease);
      currentRelease = { version: releaseMatch[1] ?? "", sections: [] };
      currentSection = null;
      continue;
    }

    const sectionMatch = line.match(/^### (.+)$/);
    if (sectionMatch && currentRelease) {
      currentSection = { title: sectionMatch[1] ?? "", items: [] };
      currentRelease.sections.push(currentSection);
      continue;
    }

    if (line.startsWith("- ") && currentSection) {
      currentSection.items.push(line.slice(2));
    }
  }

  if (currentRelease) releases.push(currentRelease);

  return releases.filter(
    (release) =>
      release.version !== "Unreleased" &&
      release.sections.some((section) => section.items.length > 0),
  );
}

export default async function ChangelogPage() {
  const releases = await getChangelog();

  return (
    <section className="w-full">
      <Container className="flex flex-col gap-12 pt-30 pb-24">
        <div className="flex max-w-3xl flex-col gap-5">
          <Header>Change Log</Header>
          <p className="text-muted-foreground text-lg leading-8">
            Product updates, fixes, and release notes for memoize.
          </p>
        </div>

        <div className="grid gap-8">
          {releases.map((release) => (
            <article
              key={release.version}
              className="border-natural-white/10 bg-natural-white/5 rounded-2xl border p-6 shadow-card-lg md:p-8"
            >
              <div className="flex flex-col gap-8 md:grid md:grid-cols-[160px_1fr]">
                <h2 className="text-heading font-mono text-2xl font-semibold">
                  {release.version}
                </h2>
                <div className="grid gap-8">
                  {release.sections.map((section) => (
                    <section key={`${release.version}-${section.title}`}>
                      <h3 className="text-natural-white text-sm font-semibold tracking-wide uppercase">
                        {section.title}
                      </h3>
                      <ul className="mt-4 grid gap-3">
                        {section.items.map((item) => (
                          <li
                            key={item}
                            className="text-muted-foreground flex gap-3 text-sm leading-6"
                          >
                            <span className="bg-primary mt-2 size-1.5 shrink-0 rounded-full" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      </Container>
    </section>
  );
}
