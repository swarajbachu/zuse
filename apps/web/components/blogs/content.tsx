import { Container } from "@/components/container";
import { getMDXComponents } from "@/mdx-components";
import { Page } from "fumadocs-core/source";
import { DocCollectionEntry } from "fumadocs-mdx/runtime/server";
import { BlogMetadata } from "@/source.config";
import { FloatingToc } from "@/components/blogs/floating-toc";

export const Content = ({
  page,
}: {
  page: Page<undefined, DocCollectionEntry<"blogPosts", BlogMetadata>>;
}) => {
  const Mdx = page.data.body;
  const titleFromTocItem = (item: (typeof page.data.toc)[number]) => {
    if (typeof item.title === "string") return item.title;

    return item.url
      .replace(/^#/, "")
      .split("-")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  const tocItems = page.data.toc.map((item) => ({
    url: item.url,
    title: titleFromTocItem(item),
  }));

  return (
    <section className="w-full pb-28">
      <Container className="relative w-full">
        <div className="prose mx-auto min-w-0 max-w-3xl">
          <Mdx components={getMDXComponents()} />
        </div>
      </Container>
      <FloatingToc items={tocItems} />
    </section>
  );
};
