import { requireNativeViewManager } from "expo-modules-core";
import type { ComponentType } from "react";
import type { ZuseMobileTerminalViewProps } from "./ZuseMobileTerminalView.types";

export type * from "./ZuseMobileTerminalView.types";

export const ZuseMobileTerminalView: ComponentType<ZuseMobileTerminalViewProps> =
	requireNativeViewManager("ZuseMobileTerminal", "TerminalView");
