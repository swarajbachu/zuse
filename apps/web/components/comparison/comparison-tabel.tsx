import { cn } from "@/lib/utils";
import { CallIcon, GreenCheckIcon, WarningIcon } from "@/components/icons/general";
import { LogoMark } from "@/components/logo";
import { Button } from "@/components/button";
import React from "react";

export interface ComparisonData {
  title: string;
  zuse: string;
  traditional: string;
  icon: React.ReactNode;
}

export const ComparisonTabel = ({ cards }: { cards: ComparisonData[] }) => {
  return (
    <div className="w-full">
      {/* header */}
      <div
        className={cn(
          "relative grid grid-cols-3 px-12",
          "*:data-[slot=tabel-cell]:flex *:data-[slot=tabel-cell]:items-center *:data-[slot=tabel-cell]:gap-3 *:data-[slot=tabel-cell]:py-8",
        )}
      >
        <div data-slot="tabel-cell" className="relative">
          <div className="absolute inset-0 top-4 -left-8 w-8/10 rounded-t-3xl bg-secondary" />
        </div>
        <div data-slot="tabel-cell">
          <LogoMark className="size-7" />
          <span className="-tracking-sm text-foreground text-lg leading-4.5 font-medium">
            Zuse Alpha
          </span>
        </div>
        <div data-slot="tabel-cell">
          <span className="-tracking-sm text-muted-foreground text-lg leading-4.5 font-medium">
            Raw terminal CLIs
          </span>
        </div>
      </div>
      {cards.map((card) => (
        <React.Fragment key={card.title}>
          <div className="bg-white/10 h-px w-full" />
          <div
            className={cn(
              "relative grid grid-cols-3 px-12",
              "*:data-[slot=tabel-cell]:flex *:data-[slot=tabel-cell]:items-center *:data-[slot=tabel-cell]:gap-3 *:data-[slot=tabel-cell]:py-8",
            )}
          >
            <div data-slot="tabel-cell" className="relative">
              <div className="absolute inset-0 -left-8 w-8/10 bg-secondary" />
              <span className="z-10 flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                {card.icon}
              </span>
              <span className="-tracking-sm text-foreground z-10 text-lg leading-4.5 font-medium">
                {card.title}
              </span>
            </div>
            <div data-slot="tabel-cell">
              <GreenCheckIcon />
              <span className="-tracking-sm text-foreground text-lg leading-4.5 font-medium">
                {card.zuse}
              </span>
            </div>
            <div data-slot="tabel-cell">
              <WarningIcon />
              <span className="-tracking-sm text-muted-foreground text-lg leading-4.5 font-medium">
                {card.traditional}
              </span>
            </div>
          </div>
        </React.Fragment>
      ))}
      <div className="bg-white/10 h-px w-full" />
      <div
        className={cn(
          "relative grid grid-cols-3 px-12",
          "*:data-[slot=tabel-cell]:flex *:data-[slot=tabel-cell]:items-center *:data-[slot=tabel-cell]:gap-3 *:data-[slot=tabel-cell]:py-8",
        )}
      >
        <div data-slot="tabel-cell" className="relative">
          <div className="absolute inset-0 bottom-4 -left-8 w-8/10 rounded-b-3xl bg-secondary" />
          <span className="z-10">
            <CallIcon />
          </span>
          <span className="-tracking-sm text-foreground z-10 text-lg leading-4.5 font-medium">
            Free public Alpha
          </span>
        </div>
        <div data-slot="tabel-cell">
          <Button />
        </div>
        <div data-slot="tabel-cell">
          <span className="-tracking-sm text-muted-foreground text-lg leading-4.5 font-medium">
            Keep wrangling CLIs
          </span>
        </div>
      </div>
    </div>
  );
};
