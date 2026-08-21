import { cn } from "@/components/tpl/nodus/lib/utils";

export const DivideX = ({ className }: { className?: string }) => {
	return <div className={cn("bg-divide h-[1px] w-full", className)} />;
};
