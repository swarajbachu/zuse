"use client";

import { cn } from "@/lib/utils";
import Link from "next/link";
import { DOWNLOAD_URL } from "@/lib/site";

/**
 * Primary CTA. Renders a link (defaults to the Mac download). Keeps the
 * sliding box micro-interaction while using a real Apple logo.
 */
export const Button = ({
  text = "Download for Mac",
  href = DOWNLOAD_URL,
  showIcon = true,
  containerClassName,
}: {
  text?: string;
  href?: string;
  showIcon?: boolean;
  containerClassName?: string;
}) => {
  const external = href.startsWith("http");
  return (
    <Link
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cn(
        "group relative flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-white/20 bg-black py-2 pr-4 pl-11 tracking-tight",
        containerClassName,
      )}
    >
      <Box showIcon={showIcon} />
      <div className="absolute -inset-px rounded-lg bg-white/15 transition-[clip-path] duration-400 ease-out [clip-path:inset(0_100%_0_0)] group-hover:[clip-path:inset(0_0%_0_0)]" />
      <span className="inline-block text-white transition-transform duration-400 group-hover:-translate-x-8">
        {text}
      </span>
    </Link>
  );
};

const Box = ({ showIcon }: { showIcon?: boolean }) => {
  return (
    <div
      data-slot="button-box"
      className="bg-primary absolute inset-y-0 left-1 z-40 my-auto flex size-8 items-center justify-center rounded-[5px] transition-all duration-400 ease-out group-hover:left-[calc(100%-2.3rem)] group-hover:rotate-180 group-hover:transform"
    >
      {showIcon && (
        <AppleLogo className="size-5 text-black transition-transform duration-400 ease-out group-hover:rotate-180" />
      )}
    </div>
  );
};

const AppleLogo = ({ className }: { className?: string }) => {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <path d="M17.05 12.44c-.03-2.42 1.98-3.58 2.07-3.64-1.13-1.65-2.88-1.87-3.49-1.9-1.47-.15-2.9.87-3.65.87-.77 0-1.94-.85-3.19-.83-1.64.02-3.16.96-4 2.43-1.71 2.96-.44 7.32 1.2 9.72.82 1.17 1.78 2.47 3.03 2.43 1.22-.05 1.68-.78 3.15-.78 1.46 0 1.89.78 3.18.76 1.32-.02 2.15-1.18 2.94-2.36.94-1.34 1.32-2.66 1.34-2.73-.03-.01-2.55-.98-2.58-3.97ZM14.67 5.34c.66-.82 1.11-1.94.99-3.06-.96.04-2.16.66-2.85 1.47-.61.7-1.16 1.86-1.02 2.95 1.08.08 2.19-.55 2.88-1.36Z" />
    </svg>
  );
};
