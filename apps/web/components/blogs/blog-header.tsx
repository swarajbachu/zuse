import { Page } from "fumadocs-core/source";
import { Container } from "@/components/container";
import { DocCollectionEntry } from "fumadocs-mdx/runtime/server";
import Image from "next/image";
import { BlogMetadata } from "@/source.config";

export const BlogHeader = ({
  page,
}: {
  page: Page<undefined, DocCollectionEntry<"blogPosts", BlogMetadata>>;
}) => {
  return (
    <Container className="grid grid-cols-1 gap-10 py-10 lg:py-30 lg:grid-cols-2 lg:items-center lg:gap-15">
      <div className="flex h-full flex-col items-center lg:items-start justify-between gap-6 pt-8">
        <div className="flex flex-col gap-6 items-center lg:items-start">
          <div className="flex flex-col items-center lg:items-start gap-3">
            <div className="text-muted-foreground -tracking-xs flex items-center gap-1 text-sm leading-3.5 font-normal">
              <span>
                {new Date(page.data.date).toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <div className="bg-muted-foreground mx-1 h-px w-4 opacity-75" />
              <span>{page.data.timeToRead}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {page?.data?.labels?.map((label) => (
                <div
                  key={label.name}
                  className="gap-2.5 rounded-md px-3 py-1.5"
                  style={{
                    backgroundColor: label.hex,
                    color: "#0a0a0c",
                  }}
                >
                  <span className="-tracking-xs text-sm leading-3 font-semibold">
                    {label.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <h1 className="-tracking-xl text-5xl leading-14 font-medium">
            {page.data.title}
          </h1>
          <p className="text-muted-foreground text-center lg:text-start -tracking-xs text-base leading-6 font-medium">
            {page.data.description}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Image
            src={page.data.authorAvatar}
            alt=""
            width={32}
            height={32}
            className="rounded-full"
          />
          <div className="flex flex-col gap-1.5">
            <span className="-tracking-xs text-xs leading-3 font-medium">
              {page.data.authorName}
            </span>
            <span className="text-muted-foreground -tracking-xs text-xs leading-3 font-medium">
              {page.data.authorRole}
            </span>
          </div>
        </div>
      </div>
      <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/5">
        <Image
          src={page.data.previewImage}
          alt={page.data.title}
          width={1200}
          height={900}
          className="h-full w-full object-cover"
          priority
        />
      </div>
    </Container>
  );
};
