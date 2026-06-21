import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

// Minimal alert surface. The card uses a solid full-opacity warm tint —
// `color-mix` blends ~14% of the semantic color into `--card` so the surface
// reads as a single hard color (e.g. a dark warm red for error in dark
// mode), not a transparent wash on top of the page. No borders.
const alertVariants = cva(
  "relative grid w-full items-start gap-x-2 gap-y-0.5 rounded-md border border-transparent px-3.5 py-3 text-foreground text-sm ring-1 ring-inset ring-border/35 has-[>svg]:has-data-[slot=alert-action]:grid-cols-[calc(var(--spacing)*4)_1fr_auto] has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-data-[slot=alert-action]:grid-cols-[1fr_auto] has-[>svg]:gap-x-2 [&>svg]:h-lh [&>svg]:w-4",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "bg-card [&>svg]:text-muted-foreground",
        error: "bg-alert-error-bg [&>svg]:text-destructive",
        info: "bg-alert-info-bg [&>svg]:text-info",
        success: "bg-alert-success-bg [&>svg]:text-success",
        warning: "bg-alert-warning-bg [&>svg]:text-warning",
      },
    },
  },
);

export function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants>): React.ReactElement {
  return (
    <div
      className={cn(alertVariants({ variant }), className)}
      data-slot="alert"
      role="alert"
      {...props}
    />
  );
}

export function AlertTitle({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("font-medium [svg~&]:col-start-2", className)}
      data-slot="alert-title"
      {...props}
    />
  );
}

export function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 text-muted-foreground [svg~&]:col-start-2",
        className,
      )}
      data-slot="alert-description"
      {...props}
    />
  );
}

export function AlertAction({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "flex gap-1 max-sm:col-start-2 max-sm:mt-2 sm:row-start-1 sm:row-end-3 sm:self-center sm:[[data-slot=alert-description]~&]:col-start-2 sm:[[data-slot=alert-title]~&]:col-start-2 sm:[svg~&]:col-start-2 sm:[svg~[data-slot=alert-description]~&]:col-start-3 sm:[svg~[data-slot=alert-title]~&]:col-start-3",
        className,
      )}
      data-slot="alert-action"
      {...props}
    />
  );
}
