import { Button } from "@/components/button";

export const CTACard = () => {
  return (
    <div className="bg-card flex flex-col gap-8 rounded-3xl border border-white/10 px-6 py-8 shadow-card-md w-full lg:max-w-lg">
      <div className="flex flex-col gap-3">
        <span className="font-medium text-foreground text-2xl leading-8 -tracking-sm">
          Ready to token max on your Mac?
        </span>
        <span className="font-medium text-muted-foreground text-base -tracking-xs leading-6">
          Bring your own keys, keep everything local, and run more useful agent
          work through the subscriptions you already have.
        </span>
      </div>
      <div>
        <Button text="Download for Mac" />
      </div>
    </div>
  );
};
