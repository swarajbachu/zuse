import { cn } from "@/lib/utils";
import React from "react";

export const Header = ({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) => {
  return (
    <h2
      className={cn(
        `text-heading text-left text-4xl font-semibold tracking-tight md:text-5xl`,
        className,
      )}
      {...props}
    >
      {children}
    </h2>
  );
};
