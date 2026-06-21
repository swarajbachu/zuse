import { cn } from "@/lib/utils";

export const FilterBadge = ({
  isSelected = false,
  className,
  children,
}: {
  isSelected?: boolean;
  className?: string;
  children?: React.ReactNode;
}) => {
  return (
    <div
      className={cn(
        "gap-2.5 rounded-lg px-6 py-3",
        "-tracking-xs text-lg leading-4.5 font-medium hover:bg-secondary/75 cursor-pointer",
        isSelected && "border-white/10 border bg-secondary",
        className,
      )}
    >
      {children}
    </div>
  );
};
