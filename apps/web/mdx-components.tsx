import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { cn } from "@/lib/utils";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
    h1: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h1
        className={cn(
          "group font-heading mt-2 scroll-m-20 text-4xl font-bold",
          className,
        )}
        {...props}
      />
    ),
    h2: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h2
        className={cn(
          "group font-heading mt-12 scroll-m-20 pb-2 text-2xl font-semibold tracking-tight first:mt-0",
          className,
        )}
        {...props}
      />
    ),
    h3: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h3
        className={cn(
          "group font-heading mt-8 scroll-m-20 text-xl font-semibold tracking-tight",
          className,
        )}
        {...props}
      />
    ),
    h4: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h4
        className={cn(
          "group font-heading mt-8 scroll-m-20 text-lg font-semibold tracking-tight",
          className,
        )}
        {...props}
      />
    ),
    h5: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h5
        className={cn(
          "group mt-8 scroll-m-20 text-lg font-semibold tracking-tight",
          className,
        )}
        {...props}
      />
    ),
    h6: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h6
        className={cn(
          "group mt-8 scroll-m-20 text-base font-semibold tracking-tight",
          className,
        )}
        {...props}
      />
    ),
    a: ({ className, ...props }: React.HTMLAttributes<HTMLAnchorElement>) => (
      <a
        className={cn("font-medium underline underline-offset-4", className)}
        {...props}
      />
    ),
    p: ({
      className,
      ...props
    }: React.HTMLAttributes<HTMLParagraphElement>) => (
      <p className={cn("leading-7 not-first:mt-6", className)} {...props} />
    ),
    ul: ({ className, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
      <ul className={cn("my-6 ml-6 list-disc", className)} {...props} />
    ),
    ol: ({ className, ...props }: React.HTMLAttributes<HTMLOListElement>) => (
      <ol className={cn("my-6 ml-6 list-decimal", className)} {...props} />
    ),
    li: ({ className, ...props }: React.HTMLAttributes<HTMLElement>) => (
      <li className={cn("mt-2", className)} {...props} />
    ),
    blockquote: ({
      className,
      ...props
    }: React.HTMLAttributes<HTMLElement>) => (
      <blockquote
        className={cn("mt-6 border-l-2 border-white/10 pl-6 italic", className)}
        {...props}
      />
    ),
    img: ({
      className,
      alt,
      ...props
    }: React.ImgHTMLAttributes<HTMLImageElement>) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img className={cn("rounded-md", className)} alt={alt} {...props} />
    ),
    hr: ({ ...props }: React.HTMLAttributes<HTMLHRElement>) => (
      <hr className="my-4 md:my-8 border-white/10" {...props} />
    ),
    table: ({
      className,
      ...props
    }: React.HTMLAttributes<HTMLTableElement>) => (
      <div className="my-6 w-full overflow-y-auto">
        <table className={cn("w-full", className)} {...props} />
      </div>
    ),
    tr: ({
      className,
      ...props
    }: React.HTMLAttributes<HTMLTableRowElement>) => (
      <tr
        className={cn("even:bg-muted m-0 border-t border-white/10 p-0", className)}
        {...props}
      />
    ),
    th: ({
      className,
      ...props
    }: React.HTMLAttributes<HTMLTableCellElement>) => (
      <th
        className={cn(
          "border border-white/10 px-4 py-2 text-left font-bold [[align=center]]:text-center [[align=right]]:text-right",
          className,
        )}
        {...props}
      />
    ),
    td: ({
      className,
      ...props
    }: React.HTMLAttributes<HTMLTableCellElement>) => (
      <td
        className={cn(
          "border border-white/10 px-4 py-2 text-left [[align=center]]:text-center [[align=right]]:text-right",
          className,
        )}
        {...props}
      />
    ),
    code: ({ children }) => (
      <code className="bg-muted text-foreground rounded px-1 py-0.5 text-sm">
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="bg-muted mt-6 overflow-x-auto rounded-lg p-4 text-sm">
        {children}
      </pre>
    ),
  };
}
