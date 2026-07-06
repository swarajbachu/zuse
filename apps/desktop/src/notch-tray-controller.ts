import { BrowserWindow, screen, type Display, type Rectangle } from "electron";
import * as Path from "node:path";

import {
  detectNotchDisplaySupport,
  findNotchedDisplay,
  type NotchDisplaySupport,
} from "./notch-display.ts";

export type NotchTrayItem = {
  readonly id: string;
  readonly chatId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly state:
    | "running"
    | "completed"
    | "failed"
    | "planReady"
    | "question"
    | "permission";
  readonly label: string;
  readonly updatedAt: number;
};

const TRAY_WIDTH = 248;
const NOTCH_CAP_HEIGHT = 66;
const MIN_EXPANDED_HEIGHT = 128;
const MAX_EXPANDED_HEIGHT = 372;
const TOP_OFFSET = -1;
const ROW_HEIGHT = 32;
const MAX_ROWS = 8;
const LIST_PADDING = 22;
const FOOTER_HEIGHT = 18;
const RESIZE_ANIMATION_MS = 220;

type ControllerOptions = {
  readonly preloadPath: string;
  readonly devServerUrl: string;
  readonly packagedRendererDir: string;
};

export class NotchTrayController {
  private window: BrowserWindow | null = null;
  private enabled = false;
  private pinned = false;
  private hovered = false;
  private items: ReadonlyArray<NotchTrayItem> = [];
  private currentHeight = NOTCH_CAP_HEIGHT;
  private resizeAnimation: ReturnType<typeof setInterval> | null = null;
  private lastSupport: NotchDisplaySupport = {
    supported: false,
    reason: process.platform === "darwin" ? "no-notched-display" : "not-macos",
  };

  constructor(private readonly options: ControllerOptions) {
    const refresh = () => this.refresh();
    screen.on("display-added", refresh);
    screen.on("display-removed", refresh);
    screen.on("display-metrics-changed", refresh);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.refresh();
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned;
    this.sendPinned();
    this.resizeAndPosition();
  }

  setHovered(hovered: boolean): void {
    this.hovered = hovered;
    this.resizeAndPosition();
  }

  setItems(items: ReadonlyArray<NotchTrayItem>): void {
    this.items = items;
    this.window?.webContents.send("notch:items", items);
    this.resizeAndPosition();
  }

  getSupport(): NotchDisplaySupport {
    return detectNotchDisplaySupport(process.platform, screen.getAllDisplays());
  }

  destroy(): void {
    this.stopResizeAnimation();
    if (this.window !== null && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
  }

  private refresh(): void {
    const support = this.getSupport();
    const changed =
      support.supported !== this.lastSupport.supported ||
      support.reason !== this.lastSupport.reason;
    this.lastSupport = support;
    if (changed) this.broadcastSupport();

    if (!this.enabled || !support.supported) {
      this.destroy();
      return;
    }

    this.ensureWindow();
    this.resizeAndPosition();
  }

  private ensureWindow(): void {
    if (this.window !== null && !this.window.isDestroyed()) return;

    this.window = new BrowserWindow({
      width: TRAY_WIDTH,
      height: NOTCH_CAP_HEIGHT,
      show: false,
      type: "panel",
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      roundedCorners: false,
      enableLargerThanScreen: true,
      titleBarStyle: "hidden",
      backgroundColor: "#00000000",
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    this.window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
    });
    this.window.setAlwaysOnTop(true, "screen-saver");
    this.window.once("ready-to-show", () => {
      this.resizeAndPosition();
      this.window?.showInactive();
      this.sendItems();
      this.sendPinned();
      this.broadcastSupport();
    });
    this.window.on("closed", () => {
      this.window = null;
    });

    if (this.options.devServerUrl) {
      void this.window.loadURL(`${this.options.devServerUrl}/notch.html`);
    } else {
      void this.window.loadFile(
        Path.join(this.options.packagedRendererDir, "notch.html"),
      );
    }
  }

  private expanded(): boolean {
    return this.pinned || this.hovered;
  }

  private targetHeight(): number {
    if (!this.expanded()) return NOTCH_CAP_HEIGHT;
    const rowCount = Math.min(MAX_ROWS, Math.max(1, this.items.length));
    const footer = this.items.length > MAX_ROWS ? FOOTER_HEIGHT : 0;
    const contentHeight =
      NOTCH_CAP_HEIGHT + LIST_PADDING + rowCount * ROW_HEIGHT + footer;
    return Math.max(
      MIN_EXPANDED_HEIGHT,
      Math.min(MAX_EXPANDED_HEIGHT, contentHeight),
    );
  }

  private targetDisplay(): Display | null {
    return findNotchedDisplay(process.platform, screen.getAllDisplays());
  }

  private targetTop(display: Display): number {
    const menuBarInset = Math.max(0, display.workArea.y - display.bounds.y);
    return display.bounds.y - menuBarInset;
  }

  private resizeAndPosition(): void {
    if (this.window === null || this.window.isDestroyed()) return;
    const display = this.targetDisplay();
    if (display === null) {
      this.destroy();
      return;
    }
    const height = this.targetHeight();
    const x = Math.round(
      display.bounds.x + (display.bounds.width - TRAY_WIDTH) / 2,
    );
    const y = Math.round(this.targetTop(display) + TOP_OFFSET);
    this.animateToBounds({ x, y, width: TRAY_WIDTH, height });
    if (!this.window.isVisible()) this.window.showInactive();
  }

  private animateToBounds(bounds: Rectangle): void {
    if (this.window === null || this.window.isDestroyed()) return;
    this.window.setPosition(bounds.x, bounds.y, false);
    if (!this.window.isVisible()) {
      this.currentHeight = bounds.height;
      this.window.setBounds(bounds, false);
      return;
    }

    this.stopResizeAnimation();
    const fromHeight = this.currentHeight;
    const heightDelta = bounds.height - fromHeight;
    if (Math.abs(heightDelta) < 2) {
      this.currentHeight = bounds.height;
      this.window.setBounds(bounds, false);
      return;
    }

    const startedAt = Date.now();
    this.resizeAnimation = setInterval(() => {
      if (this.window === null || this.window.isDestroyed()) {
        this.stopResizeAnimation();
        return;
      }

      const progress = Math.min(
        1,
        (Date.now() - startedAt) / RESIZE_ANIMATION_MS,
      );
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextHeight = Math.round(fromHeight + heightDelta * eased);
      this.currentHeight = nextHeight;
      this.window.setBounds({ ...bounds, height: nextHeight }, false);

      if (progress === 1) {
        this.currentHeight = bounds.height;
        this.stopResizeAnimation();
      }
    }, 16);
  }

  private stopResizeAnimation(): void {
    if (this.resizeAnimation === null) return;
    clearInterval(this.resizeAnimation);
    this.resizeAnimation = null;
  }

  private sendItems(): void {
    this.window?.webContents.send("notch:items", this.items);
  }

  private sendPinned(): void {
    this.window?.webContents.send("notch:pinned", this.pinned);
  }

  private broadcastSupport(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("notch:display-support", this.lastSupport);
      }
    }
  }
}
