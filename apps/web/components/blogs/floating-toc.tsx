"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

type TocItem = {
  title: string;
  url: string;
};

const MorphingLabel = ({ text }: { text: string }) => {
  return (
    <span className="relative block h-5 overflow-hidden">
      <span
        key={text}
        className="animate-toc-label-change absolute inset-x-0 top-0 block truncate text-sm font-medium leading-5 text-foreground"
      >
        {text}
      </span>
    </span>
  );
};

export const FloatingToc = ({ items }: { items: TocItem[] }) => {
  const [activeUrl, setActiveUrl] = useState(items[0]?.url ?? "");
  const [open, setOpen] = useState(false);

  const activeItem = useMemo(
    () => items.find((item) => item.url === activeUrl) ?? items[0],
    [activeUrl, items],
  );

  useEffect(() => {
    if (!items.length) return;

    const headings = items
      .map((item) => document.querySelector(item.url))
      .filter((heading): heading is Element => Boolean(heading));

    if (!headings.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          )[0];

        if (visible?.target.id) {
          setActiveUrl(`#${visible.target.id}`);
        }
      },
      {
        rootMargin: "-18% 0px -68% 0px",
        threshold: [0, 1],
      },
    );

    headings.forEach((heading) => observer.observe(heading));

    return () => observer.disconnect();
  }, [items]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!items.length) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4 sm:bottom-7">
      <div className="pointer-events-auto w-full max-w-lg">
        {open ? (
          <div
            id="blog-floating-toc"
            className="mb-2 animate-toc-popup-enter overflow-hidden rounded-2xl border border-white/10 bg-[#111214]/95 shadow-2xl shadow-black/40 backdrop-blur-xl"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
              <span className="text-muted-foreground text-xs font-medium uppercase tracking-[0.16em]">
                On this page
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-300"
                aria-label="Close table of contents"
              >
                Close
              </button>
            </div>
            <nav className="max-h-[min(58vh,28rem)] overflow-y-auto p-2">
              {items.map((item, index) => {
                const selected = item.url === activeUrl;

                return (
                  <Link
                    key={item.url}
                    href={item.url}
                    onClick={() => {
                      setActiveUrl(item.url);
                      setOpen(false);
                  }}
                  className={cn(
                      "group flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-[background-color,color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-300",
                      selected
                        ? "bg-lime-300 text-black"
                        : "text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "shrink-0 font-mono text-xs tabular-nums",
                        selected
                          ? "text-black"
                          : "text-muted-foreground group-hover:text-foreground",
                      )}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="line-clamp-2">{item.title}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="group mx-auto flex h-11 w-full max-w-md items-center gap-3 rounded-full border border-white/10 bg-[#17181a]/95 px-4 text-left shadow-2xl shadow-black/45 backdrop-blur-xl transition-[background-color,border-color,transform] duration-200 ease-out hover:border-white/20 hover:bg-[#1d1f21] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-300 active:scale-[0.99]"
          aria-expanded={open}
          aria-controls="blog-floating-toc"
        >
          <span className="min-w-0 flex-1">
            <MorphingLabel text={activeItem?.title ?? ""} />
          </span>
          <span className="text-muted-foreground hidden shrink-0 pr-2 text-xs font-medium sm:block">
            {items.findIndex((item) => item.url === activeUrl) + 1}/{items.length}
          </span>
        </button>
      </div>
    </div>
  );
};
