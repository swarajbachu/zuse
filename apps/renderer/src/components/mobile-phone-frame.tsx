import type React from "react";

import { cn } from "../lib/utils.ts";

export function MobilePhoneFrame({
  frameUrl,
  children,
}: {
  readonly frameUrl: string | null;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      <div className="relative flex max-h-full w-full max-w-[min(82vw,22rem)] aspect-[9/19.5] rounded-[2.7rem] bg-zinc-950 p-2 shadow-[0_18px_50px_rgba(0,0,0,0.34)] ring-1 ring-white/10">
        <div className="pointer-events-none absolute left-1/2 top-3 z-10 h-5 w-24 -translate-x-1/2 rounded-full bg-black/90 shadow-sm" />
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-[2.15rem] bg-black ring-1 ring-white/10">
          {frameUrl !== null ? (
            <img
              src={frameUrl}
              alt="iOS Simulator"
              className="h-full w-full object-contain"
              draggable={false}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-8 text-center text-xs text-zinc-500">
              No stream
            </div>
          )}
          <div className={cn("absolute inset-0 pointer-events-none")}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
