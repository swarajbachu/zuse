import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const Container = ({
  children,
  className,
  ...props
}: {
  children: ReactNode;
  className?: string;
} & HTMLAttributes<HTMLDivElement>) => {
  return (
    <div
      {...props}
      data-slot="container"
      className={cn(
        "max-w-container mx-auto w-full px-4 sm:px-6 lg:px-8",
        className,
      )}
    >
      {children}
    </div>
  );
};
