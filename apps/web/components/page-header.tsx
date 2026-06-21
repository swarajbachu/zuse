import { cn } from "@/lib/utils";

export const PageHeader = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  return (
    <h2
      className={cn(
        "absolute top-20 overflow-hidden opacity-30 md:top-30 lg:top-50",
        "-tracking-xl text-page-header font-medium md:text-page-header-md lg:text-page-header-lg",
        "bg-linear-180 from-white/70 to-transparent bg-clip-text text-transparent",
        className,
      )}
    >
      {children}
    </h2>
  );
};
