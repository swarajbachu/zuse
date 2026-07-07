import type { ReactNode, ComponentPropsWithoutRef } from "react";

import { cn } from "~/lib/utils";

type Tone = "default" | "warning" | "accent";

const TONE_ICON: Record<Tone, string> = {
  default: "text-muted-foreground",
  warning: "text-amber-300",
  accent: "text-primary",
};

const TONE_TITLE: Record<Tone, string> = {
  default: "text-foreground",
  warning: "text-amber-100",
  accent: "text-foreground",
};

interface TrayPillProps
  extends Omit<ComponentPropsWithoutRef<"div">, "title"> {
  /** Rendered before the icon — used by queue rows for the drag grip. */
  readonly leading?: ReactNode;
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly tone?: Tone;
  readonly expanded?: ReactNode;
  /**
   * When true, the pill drops its rounded outer border/background and renders
   * as a flush row separated from siblings by a thin bottom border. Use for
   * trays that live inside the composer Card and want to share its surface.
   */
  readonly flush?: boolean;
  /**
   * When provided, the icon/title/subtitle area becomes a button that fires
   * this handler. Actions stay outside the button so they keep their own
   * click behavior. Use for the plan-tray "click header to expand" pattern.
   */
  readonly onPillClick?: () => void;
  readonly ariaExpanded?: boolean;
  readonly ariaLabel?: string;
}

/**
 * Compact pill row used by every above-composer tray (queue items, project
 * plan, goal, warnings). One row ≈ 32px tall. Multiple pills stack vertically
 * with the surrounding `flex flex-col gap-1` container in chat-composer.
 *
 * When `expanded` is provided, it renders as an attached section below the
 * header row inside the same rounded surface — used by ProjectPlanTray for
 * the open todo timeline.
 */
export function TrayPill({
  leading,
  icon,
  title,
  subtitle,
  actions,
  tone = "default",
  expanded,
  flush = false,
  onPillClick,
  ariaExpanded,
  ariaLabel,
  className,
  children,
  ...rest
}: TrayPillProps) {
  const iconNode =
    icon !== undefined ? (
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center",
          TONE_ICON[tone],
        )}
      >
        {icon}
      </span>
    ) : null;

  const titleNode = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span
        className={cn(
          "min-w-0 truncate font-medium",
          TONE_TITLE[tone],
        )}
      >
        {title}
      </span>
      {subtitle !== undefined ? (
        <span className="min-w-0 truncate text-muted-foreground">
          {subtitle}
        </span>
      ) : null}
    </div>
  );

  const rowBody =
    onPillClick !== undefined ? (
      <button
        type="button"
        onClick={onPillClick}
        aria-expanded={ariaExpanded}
        aria-label={ariaLabel}
        className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
      >
        {iconNode}
        {titleNode}
      </button>
    ) : (
      <>
        {iconNode}
        {titleNode}
      </>
    );

  return (
    <div
      className={cn(
        "text-[13px]",
        flush
          ? "border-b border-border/40 last:border-b-0"
          : "rounded-md border border-border/50 bg-muted/30",
        className,
      )}
      {...rest}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-1.5">
        {leading !== undefined ? leading : null}
        {rowBody}
        {actions !== undefined ? (
          <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
        ) : null}
      </div>
      {expanded !== undefined ? (
        <div className="border-t border-border/40">{expanded}</div>
      ) : null}
      {children}
    </div>
  );
}

/**
 * Standard icon-button used inside a pill's `actions` slot. 24px square,
 * muted by default, brightens on hover.
 */
export const trayPillActionClass =
  "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-35";
