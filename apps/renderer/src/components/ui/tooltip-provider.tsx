"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type React from "react";

/**
 * Keep the app-wide provider separate so startup does not load tooltip surfaces.
 * Defaults `delay` to 0 so tooltips feel instant; callers can override it.
 */
export function TooltipProvider({
	delay = 0,
	...props
}: TooltipPrimitive.Provider.Props): React.ReactElement {
	return <TooltipPrimitive.Provider delay={delay} {...props} />;
}
