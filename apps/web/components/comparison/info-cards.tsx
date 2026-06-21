export interface InfoCardsProps {
    title: string;
    description: string;
    icon: React.ReactNode;
}

export const InfoCards = ({ title, description, icon }: InfoCardsProps) => {
  return (
    <div className="bg-card border border-white/10 flex lg:items-center flex-col gap-3 rounded-3xl px-6 py-8">
      <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        {icon}
      </div>
      <span className="text-foreground font-medium text-xl leading-7 -tracking-sm">{title}</span>
      <span className="-tracking-xs text-base leading-6 font-medium lg:text-center text-muted-foreground">
        {description}
      </span>
    </div>
  );
};
