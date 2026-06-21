import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ComparisonData } from "@/components/comparison/comparison-tabel";
import { LogoMark } from "@/components/logo";
import { GreenCheckIcon, WarningIcon } from "@/components/icons/general";

export const ComparisonAccordion = ({ cards }: { cards: ComparisonData[] }) => {
  return (
    <div className="w-full">
      <Accordion defaultValue={[cards[0].title]} className="gap-4">
        {cards.map((card) => (
          <AccordionItem
            key={card.title}
            value={card.title}
            className="bg-card border border-white/10 rounded-3xl p-6"
          >
            <AccordionTrigger className="items-center py-0">
              <div className="relative flex items-center gap-3">
                <span className="z-10 flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  {card.icon}
                </span>
                <span className="-tracking-sm text-foreground z-10 text-lg leading-4.5 font-medium">
                  {card.title}
                </span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="mt-6 flex flex-col gap-6">
              <div className="bg-white/10 h-px w-full" />

              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <LogoMark className="size-7" />
                  <span className="-tracking-sm text-foreground text-lg leading-4.5 font-medium">
                    memoize
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <GreenCheckIcon />
                  <span className="-tracking-sm text-foreground text-lg leading-4.5 font-medium">
                    {card.memoize}
                  </span>
                </div>
              </div>

              <div className="bg-white/10 h-px w-full" />

              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <span className="-tracking-sm text-muted-foreground text-lg leading-4.5 font-medium">
                    Raw terminal CLIs
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <WarningIcon />
                  <span className="-tracking-sm text-muted-foreground text-lg leading-4.5 font-medium">
                    {card.traditional}
                  </span>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
};
