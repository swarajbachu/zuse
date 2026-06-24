import { HugeiconsIcon } from "@hugeicons/react";
import { StarIcon } from "@hugeicons-pro/core-bulk-rounded";
import { useEffect, useRef, useState } from "react";
import { Effect, Fiber, Stream } from "effect";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";

import {
  BrowserCommandResult,
  type BrowserCommandRequest,
} from "@memoize/wire";

import type { BrowserInputAction } from "../lib/bridge.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { useUiStore } from "../store/ui.ts";
import { AgentCursor, type AgentCursorIntent } from "./agent-cursor.tsx";
import { BrowserShutter } from "./browser-shutter.tsx";

/**
 * How long the cursor's CSS `transition: transform` lasts. Mirror of GLIDE_MS
 * inside `agent-cursor.tsx` — we wait this long after publishing a move
 * intent before firing the real CDP click so the visible click pulse lands at
 * the destination instead of somewhere along the path.
 */
const CURSOR_GLIDE_MS = 350;

/**
 * Duration of the JS-driven smooth scroll animation injected into the page.
 * Chosen for a clearly human pace — long enough that the user can read
 * what's passing, short enough that a multi-step scroll sequence doesn't
 * drag. The page-side rAF loop uses this exact value; the command waits
 * this long plus a small buffer before letting the next command run.
 */
const SMOOTH_SCROLL_MS = 700;

/**
 * In-app Browser tab — toolbar (back/forward/refresh/URL bar) + Electron
 * `<webview>`. The webview runs in its own process with `nodeIntegration:
 * false` by default so arbitrary user-entered URLs can't reach the host.
 *
 * State is held locally: switching away from the Browser tab keeps the
 * component mounted (RightPane uses `hidden` toggling), so URL bar value
 * and the underlying webview's history stay alive across tab switches.
 * Reloading the renderer resets the URL to blank — persistence is out of
 * scope for v1.
 */
export function BrowserPane() {
  const webviewRef = useRef<HTMLElement | null>(null);
  // Ring buffer of console messages + page errors, captured per page load so
  // `browser_console` can report them to the agent. Cleared on navigation.
  const consoleBufferRef = useRef<string[]>([]);
  // The embedded webview's webContents id — handed to main once we see
  // `dom-ready` so main can attach Chrome DevTools Protocol and dispatch real
  // input events. `null` until the first dom-ready; null disables CDP paths
  // (Click/Type/Hover/Press fall back to the previous synthetic behaviour so
  // we never silently no-op if the bridge somehow doesn't load).
  const webContentsIdRef = useRef<number | null>(null);
  const [url, setUrl] = useState<string>("");
  const [inputValue, setInputValue] = useState<string>("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // Bumped each time the agent takes a screenshot — drives the shutter flash.
  const [shutterNonce, setShutterNonce] = useState(0);
  // The current "intent" for the agent cursor overlay. Bumped on every
  // ref-targeted action (click/hover/type/press-with-ref) so the user can see
  // *where* the agent is acting. Stays at the last position once visible —
  // mirrors how a real mouse cursor doesn't disappear between actions.
  const [cursorIntent, setCursorIntent] = useState<AgentCursorIntent | null>(
    null,
  );
  const cursorNonceRef = useRef(0);

  // Wire navigation lifecycle events onto the underlying webview element.
  // We attach via `addEventListener` because the webview tag isn't a real
  // React component — it's a Chromium-provided custom element.
  useEffect(() => {
    const el = webviewRef.current;
    if (el === null) return;
    const wv = el as WebviewElement;
    const syncNav = () => {
      try {
        setCanGoBack(wv.canGoBack());
        setCanGoForward(wv.canGoForward());
      } catch {
        // webview not ready yet — events fire later
      }
    };
    const registerForCdp = () => {
      const browserBridge = window.memoize?.browser;
      if (browserBridge === undefined) return;
      let id: number;
      try {
        id = wv.getWebContentsId();
      } catch {
        // Pre-Chromium-21 / non-Electron environment — leave id null.
        return;
      }
      if (typeof id !== "number") return;
      // Drop the ref while attach is in flight so an agent action that
      // arrives between dom-ready and a successful attach can't race ahead
      // and hit `Browser input bridge is not ready`. Only set it back after
      // main confirms the debugger attached.
      webContentsIdRef.current = null;
      void browserBridge.registerWebview(id).then((ok) => {
        if (ok) webContentsIdRef.current = id;
      }).catch(() => {
        // Attach failure is non-fatal — leave id null and CDP-using tools
        // fall back to the synthetic path with a clean cursor animation.
      });
    };
    const onDidNavigate = (e: Event) => {
      const ev = e as Event & { url?: string };
      if (typeof ev.url === "string") {
        setUrl(ev.url);
        setInputValue(ev.url);
      }
      syncNav();
    };
    const onStart = () => {
      setIsLoading(true);
      // Fresh page — drop the previous page's console history.
      consoleBufferRef.current = [];
    };
    const onStop = () => {
      setIsLoading(false);
      syncNav();
    };
    const LEVELS = ["log", "info", "warning", "error"] as const;
    const onConsole = (e: Event) => {
      const ev = e as Event & {
        level?: number;
        message?: string;
        line?: number;
        sourceId?: string;
      };
      const level = LEVELS[ev.level ?? 0] ?? "log";
      const where = ev.sourceId ? ` (${ev.sourceId}:${ev.line ?? 0})` : "";
      const line = `[${level}] ${ev.message ?? ""}${where}`;
      const buf = consoleBufferRef.current;
      buf.push(line);
      if (buf.length > 200) buf.splice(0, buf.length - 200);
    };
    const onFailLoad = (e: Event) => {
      const ev = e as Event & {
        errorDescription?: string;
        validatedURL?: string;
      };
      if (ev.errorDescription) {
        consoleBufferRef.current.push(
          `[error] page load failed: ${ev.errorDescription} ${ev.validatedURL ?? ""}`.trim(),
        );
      }
    };
    const onDomReady = () => {
      syncNav();
      registerForCdp();
    };
    el.addEventListener("did-navigate", onDidNavigate);
    el.addEventListener("did-navigate-in-page", onDidNavigate);
    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("dom-ready", onDomReady);
    el.addEventListener("console-message", onConsole);
    el.addEventListener("did-fail-load", onFailLoad);
    return () => {
      el.removeEventListener("did-navigate", onDidNavigate);
      el.removeEventListener("did-navigate-in-page", onDidNavigate);
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("dom-ready", onDomReady);
      el.removeEventListener("console-message", onConsole);
      el.removeEventListener("did-fail-load", onFailLoad);
    };
  }, []);

  // Agent browser executor. Subscribe once to the server's `browser.commands`
  // broadcast and drive the webview for each command, replying on
  // `browser.respond`. Commands run serially (runForEach awaits each) so the
  // agent's navigate→screenshot sequence can't race. The component stays
  // mounted while a project is open, so this subscription lives as long as the
  // pane does.
  useEffect(() => {
    let fiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let cancelled = false;
    void (async () => {
      const client = await getRpcClient();
      if (cancelled) return;
      fiber = Effect.runFork(
        Stream.runForEach(client.browser.commands({}), (req) =>
          Effect.promise(() => executeBrowserCommand(req)),
        ),
      );
    })();

    const executeBrowserCommand = async (
      req: BrowserCommandRequest,
    ): Promise<void> => {
      // Always surface the action: open the sidebar and force the Browser
      // panel visible+active. This also un-hides the webview so `capturePage`
      // works (it returns an empty image for a `display:none` element).
      useUiStore.getState().revealPanel("browser");
      const wv = webviewRef.current as WebviewElement | null;
      const result = await runBrowserCommand(req, wv, {
        setUrl,
        setInputValue,
        flashShutter: () => setShutterNonce((n) => n + 1),
        readConsole: () => consoleBufferRef.current.join("\n"),
        moveCursor: (x, y, opts) => {
          cursorNonceRef.current += 1;
          setCursorIntent({
            nonce: cursorNonceRef.current,
            x,
            y,
            click: opts?.click === true,
            pressed: opts?.pressed === true,
          });
        },
        getWebContentsId: () => webContentsIdRef.current,
      });
      try {
        const client = await getRpcClient();
        await Effect.runPromise(client.browser.respond({ result }));
      } catch {
        // A failed respond just means this command times out server-side;
        // the agent gets a clean "browser didn't respond" tool result.
      }
    };

    return () => {
      cancelled = true;
      if (fiber !== null) void Effect.runPromise(Fiber.interrupt(fiber));
    };
  }, []);

  const navigate = (next: string) => {
    const resolved = resolveUrl(next);
    if (resolved === null) return;
    setUrl(resolved);
    setInputValue(resolved);
    const wv = webviewRef.current as WebviewElement | null;
    // Setting `src` programmatically also works, but loadURL is more
    // predictable when the same URL is re-entered (forces a reload).
    if (wv !== null) {
      try {
        void wv.loadURL(resolved);
      } catch {
        wv.src = resolved;
      }
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim() === "") return;
    navigate(inputValue.trim());
  };

  const go = (dir: "back" | "forward") => {
    const wv = webviewRef.current as WebviewElement | null;
    if (wv === null) return;
    try {
      if (dir === "back" && wv.canGoBack()) wv.goBack();
      if (dir === "forward" && wv.canGoForward()) wv.goForward();
    } catch {
      // ignore
    }
  };

  const reload = () => {
    const wv = webviewRef.current as WebviewElement | null;
    if (wv === null) return;
    try {
      if (isLoading) wv.stop();
      else wv.reload();
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <form
        onSubmit={onSubmit}
        className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs"
      >
        <ToolbarButton
          onClick={() => go("back")}
          disabled={!canGoBack}
          ariaLabel="Back"
        >
          <ChevronLeft className="size-3.5" strokeWidth={1.8} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => go("forward")}
          disabled={!canGoForward}
          ariaLabel="Forward"
        >
          <ChevronRight className="size-3.5" strokeWidth={1.8} />
        </ToolbarButton>
        <ToolbarButton
          onClick={reload}
          disabled={url === ""}
          ariaLabel={isLoading ? "Stop" : "Reload"}
        >
          <RefreshCw
            className={`size-3.5 ${isLoading ? "animate-spin" : ""}`}
            strokeWidth={1.8}
          />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            /* bookmark placeholder */
          }}
          disabled={true}
          ariaLabel="Bookmark"
        >
          <HugeiconsIcon icon={StarIcon} className="size-3.5" />
        </ToolbarButton>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Search or enter URL"
          spellCheck={false}
          className="flex-1 rounded bg-transparent px-2 py-1 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:bg-muted/40"
        />
      </form>
      <div className="relative min-h-0 flex-1">
        {url === "" ? (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            Type a URL above to start browsing.
          </div>
        ) : null}
        <webview
          ref={webviewRef as unknown as React.RefObject<HTMLElement>}
          src={url === "" ? "about:blank" : url}
          allowpopups={true}
          style={{
            display: url === "" ? "none" : "flex",
            width: "100%",
            height: "100%",
          }}
        />
        <AgentCursor intent={cursorIntent} visible={url !== ""} />
        <BrowserShutter nonce={shutterNonce} />
      </div>
    </div>
  );
}

/**
 * Drive the webview for one agent browser command and build the reply. Pure
 * helper (no React state beyond the passed-in setters) so the executor effect
 * stays small. Never throws — failures come back as `{ ok: false, error }`.
 */
async function runBrowserCommand(
  req: BrowserCommandRequest,
  wv: WebviewElement | null,
  hooks: {
    setUrl: (u: string) => void;
    setInputValue: (u: string) => void;
    flashShutter: () => void;
    readConsole: () => string;
    /**
     * Glide the agent cursor toward (x, y) in webview-relative CSS pixels.
     * `click: true` also fires the click pulse once the glide settles.
     */
    moveCursor: (
      x: number,
      y: number,
      opts?: { click?: boolean; pressed?: boolean },
    ) => void;
    /**
     * The embedded webview's webContents id once main has attached CDP.
     * `null` before the first `dom-ready`, or if the preload bridge isn't
     * available (non-Electron build of the renderer).
     */
    getWebContentsId: () => number | null;
  },
): Promise<BrowserCommandResult> {
  const fail = (error: string) =>
    BrowserCommandResult.make({ id: req.id, ok: false, error });
  if (wv === null) {
    return fail("The in-app browser is not available in this window.");
  }
  const command = req.command;
  try {
    switch (command._tag) {
      case "Navigate": {
        const resolved = resolveUrl(command.url);
        if (resolved === null) return fail(`Invalid URL: ${command.url}`);
        hooks.setUrl(resolved);
        hooks.setInputValue(resolved);
        await loadAndWait(wv, resolved);
        return BrowserCommandResult.make({
          id: req.id,
          ok: true,
          url: safeCall(() => wv.getURL(), resolved),
          title: safeCall(() => wv.getTitle(), ""),
        });
      }
      case "Screenshot": {
        const current = safeCall(() => wv.getURL(), "");
        if (current === "" || current === "about:blank") {
          return fail("No page is loaded — navigate to a URL first.");
        }
        // The tab was just made visible; give the compositor a beat to paint
        // before capturing, otherwise the frame can come back blank.
        await delay(180);
        const image = await wv.capturePage();
        if (image.isEmpty()) {
          return fail(
            "Screenshot came back empty — the page may still be loading.",
          );
        }
        const base64 = image
          .toDataURL()
          .replace(/^data:image\/png;base64,/, "");
        hooks.flashShutter();
        return BrowserCommandResult.make({
          id: req.id,
          ok: true,
          url: current,
          title: safeCall(() => wv.getTitle(), ""),
          screenshot: base64,
        });
      }
      case "Snapshot": {
        const raw = await wv.executeJavaScript(SNAPSHOT_JS);
        return BrowserCommandResult.make({
          id: req.id,
          ok: true,
          url: safeCall(() => wv.getURL(), ""),
          title: safeCall(() => wv.getTitle(), ""),
          snapshot: typeof raw === "string" ? raw : JSON.stringify(raw ?? []),
        });
      }
      case "Click": {
        if (!isValidRef(command.ref)) return fail("Invalid element ref.");
        const target = await resolveRefRect(wv, command.ref);
        if (target === null) {
          return fail(
            "No element with that ref — re-snapshot the page first.",
          );
        }
        const wcId = hooks.getWebContentsId();
        // Without CDP attached (preload bridge missing, attach failed) we
        // can't deliver real input. Fall back to the synthetic click so the
        // agent still makes progress — the cursor animation still runs so
        // the user sees *where* the click landed.
        hooks.moveCursor(target.cx, target.cy, { click: true });
        if (wcId === null) {
          await wv.executeJavaScript(
            `(() => { const el = document.querySelector('[data-mz-ref=${JSON.stringify(command.ref)}]'); if (el) el.click(); })()`,
          );
          await delay(CURSOR_GLIDE_MS + 20);
          return BrowserCommandResult.make({
            id: req.id,
            ok: true,
            detail: `Clicked ${target.label} (no-CDP fallback).`,
          });
        }
        const ok = await dispatchClickViaCdp(wcId, target.cx, target.cy);
        if (!ok) {
          // Debugger detached mid-action (webview reload, crash). Fall through
          // to synthetic so the agent still makes progress — the cursor pulse
          // already fired so the user sees *where* the click landed.
          await wv.executeJavaScript(
            `(() => { const el = document.querySelector('[data-mz-ref=${JSON.stringify(command.ref)}]'); if (el) el.click(); })()`,
          );
        }
        return BrowserCommandResult.make({
          id: req.id,
          ok: true,
          detail: `Clicked ${target.label}.`,
        });
      }
      case "Type": {
        if (!isValidRef(command.ref)) return fail("Invalid element ref.");
        const submit = command.submit === true;
        const target = await resolveRefRect(wv, command.ref);
        if (target === null) {
          return fail("No element with that ref — re-snapshot first.");
        }
        // Glide the cursor to the field with a click pulse — visually frames
        // the field activation. Real focus happens via CDP click (or .focus()
        // when CDP isn't available) so the input shows its native focus ring.
        const wcId = hooks.getWebContentsId();
        hooks.moveCursor(target.cx, target.cy, { click: true });
        if (wcId !== null) {
          await dispatchClickViaCdp(wcId, target.cx, target.cy);
        }
        // The value-setter via the prototype descriptor bypasses React's
        // value tracker — without it, React thinks the controlled value
        // didn't change and the next render reverts the input. This is the
        // industry-standard "type into a React input" approach (used by
        // Testing Library's `userEvent` and Puppeteer fallbacks); switching
        // to CDP's `Input.insertText` here would regress on common SPA
        // login forms. We keep the JS path on purpose; the real click above
        // already gave the field a true focus event.
        const res = await runJsObject(
          wv,
          `(() => { const el = document.querySelector('[data-mz-ref=${JSON.stringify(command.ref)}]'); if (!el) return JSON.stringify({ ok:false, error:'No element with that ref — re-snapshot first.' }); el.focus(); const v = ${JSON.stringify(command.text)}; const tag = el.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA') { const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value'); if (d && d.set) d.set.call(el, v); else el.value = v; } else { el.textContent = v; } el.dispatchEvent(new Event('input', { bubbles:true })); el.dispatchEvent(new Event('change', { bubbles:true })); return JSON.stringify({ ok:true, detail:'Typed into ' + ((el.getAttribute('name')||el.getAttribute('aria-label')||el.tagName)||'') }); })()`,
        );
        if (submit) {
          if (wcId !== null) {
            await dispatchKeyTap(wcId, "Enter");
          } else {
            await wv.executeJavaScript(
              `(() => { const el = document.querySelector('[data-mz-ref=${JSON.stringify(command.ref)}]'); if (!el) return; const o = { key:'Enter', keyCode:13, which:13, bubbles:true }; el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); const f = el.form; if (f && typeof f.requestSubmit === 'function') { try { f.requestSubmit(); } catch (e) {} } })()`,
            );
          }
        }
        return resultFromJs(req.id, res, `Typed into ${command.ref}.`);
      }
      case "Wait": {
        if (
          typeof command.selector === "string" &&
          command.selector.length > 0
        ) {
          const res = await runJsObject(
            wv,
            `(async () => { const sel = ${JSON.stringify(command.selector)}; const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (document.querySelector(sel)) return JSON.stringify({ ok:true, detail:'Element appeared: ' + sel }); await new Promise(r => setTimeout(r, 150)); } return JSON.stringify({ ok:false, error:'Timed out (10s) waiting for ' + sel }); })()`,
          );
          return resultFromJs(req.id, res, "Done waiting.");
        }
        const ms = Math.min(Math.max(command.ms ?? 500, 0), 15000);
        await delay(ms);
        return BrowserCommandResult.make({
          id: req.id,
          ok: true,
          detail: `Waited ${ms}ms.`,
        });
      }
      case "Scroll": {
        if (typeof command.ref === "string" && command.ref.length > 0) {
          if (!isValidRef(command.ref)) return fail("Invalid element ref.");
          // Use a JS-driven rAF animation instead of `scrollIntoView({behavior:
          // 'smooth'})` — native smooth scroll varies wildly across pages (some
          // override `scroll-behavior`, some cut the animation short on tiny
          // deltas) and feels choppy. We control duration + easing here so the
          // glide looks the same regardless of the page.
          const res = await runJsObject(
            wv,
            buildSmoothScrollRefJs(command.ref),
          );
          await delay(SMOOTH_SCROLL_MS + 60);
          const after = await resolveRefRect(wv, command.ref);
          if (after !== null) hooks.moveCursor(after.cx, after.cy);
          return resultFromJs(req.id, res, "Scrolled into view.");
        }
        const dir = command.direction ?? "down";
        // Page-step (up/down) glides smoothly. Top/bottom stay instant — on a
        // long page that's a ten-thousand-pixel scroll and animation just
        // wastes the agent's wall-clock without helping the user follow.
        const res = await runJsObject(wv, buildSmoothScrollDirJs(dir));
        if (dir === "up" || dir === "down") {
          await delay(SMOOTH_SCROLL_MS + 60);
        }
        return resultFromJs(req.id, res, `Scrolled ${dir}.`);
      }
      case "Hover": {
        if (!isValidRef(command.ref)) return fail("Invalid element ref.");
        const target = await resolveRefRect(wv, command.ref);
        if (target === null) {
          return fail("No element with that ref — re-snapshot first.");
        }
        hooks.moveCursor(target.cx, target.cy);
        const wcId = hooks.getWebContentsId();
        if (wcId !== null) {
          // Real `mouseMove` triggers Chromium's hit-testing, which is what
          // makes :hover styles and hover-only menus actually open. Synthetic
          // MouseEvents bubble through the DOM but don't flip the hover state.
          await dispatchInput(wcId, {
            type: "mouseMove",
            x: target.cx,
            y: target.cy,
          });
        } else {
          await wv.executeJavaScript(
            `(() => { const el = document.querySelector('[data-mz-ref=${JSON.stringify(command.ref)}]'); if (!el) return; const r = el.getBoundingClientRect(); const o = { bubbles:true, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }; for (const t of ['pointerover','mouseover','mouseenter','mousemove']) el.dispatchEvent(new MouseEvent(t, o)); })()`,
          );
        }
        await delay(CURSOR_GLIDE_MS + 20);
        return BrowserCommandResult.make({
          id: req.id,
          ok: true,
          detail: `Hovered ${target.label}.`,
        });
      }
      case "Select": {
        if (!isValidRef(command.ref)) return fail("Invalid element ref.");
        const res = await runJsObject(
          wv,
          `(() => { const el = document.querySelector('[data-mz-ref=${JSON.stringify(command.ref)}]'); if (!el) return JSON.stringify({ ok:false, error:'No element with that ref — re-snapshot first.' }); if (el.tagName !== 'SELECT') return JSON.stringify({ ok:false, error:'That ref is not a <select> dropdown.' }); const want = ${JSON.stringify(command.value)}; const opt = Array.from(el.options).find((o) => o.value === want || (o.textContent||'').trim() === want); if (!opt) return JSON.stringify({ ok:false, error:'No option matching "' + want + '".' }); el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles:true })); el.dispatchEvent(new Event('change', { bubbles:true })); return JSON.stringify({ ok:true, detail:'Selected ' + (opt.textContent||opt.value) }); })()`,
        );
        return resultFromJs(req.id, res, `Selected ${command.value}.`);
      }
      case "Press": {
        const wcId = hooks.getWebContentsId();
        const hasRef =
          typeof command.ref === "string" && command.ref.length > 0;
        if (hasRef && !isValidRef(command.ref as string)) {
          return fail("Invalid element ref.");
        }
        // Focus the target first (so the keystroke lands on the right
        // element). With CDP we do a real click → cursor moves to it; without
        // CDP we just call `.focus()` via JS.
        if (hasRef) {
          const target = await resolveRefRect(wv, command.ref as string);
          if (target === null) {
            return fail("No element with that ref — re-snapshot first.");
          }
          hooks.moveCursor(target.cx, target.cy, { click: true });
          if (wcId !== null) {
            await dispatchClickViaCdp(wcId, target.cx, target.cy);
          } else {
            await wv.executeJavaScript(
              `(() => { const el = document.querySelector('[data-mz-ref=${JSON.stringify(command.ref as string)}]'); if (el && typeof el.focus === 'function') el.focus(); })()`,
            );
            await delay(CURSOR_GLIDE_MS + 20);
          }
        }
        if (wcId !== null) {
          await dispatchKeyTap(wcId, command.key);
        } else {
          await wv.executeJavaScript(
            `(() => { const el = document.activeElement || document.body; const key = ${JSON.stringify(command.key)}; const o = { key, bubbles:true, cancelable:true }; el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); if (key === 'Enter' && el.form && typeof el.form.requestSubmit === 'function') { try { el.form.requestSubmit(); } catch (e) {} } })()`,
          );
        }
        return BrowserCommandResult.make({
          id: req.id,
          ok: true,
          detail: `Pressed ${command.key}.`,
        });
      }
      case "Read": {
        const refExpr =
          typeof command.ref === "string" && command.ref.length > 0
            ? isValidRef(command.ref)
              ? `document.querySelector('[data-mz-ref=${JSON.stringify(command.ref)}]')`
              : null
            : `document.body`;
        if (refExpr === null) return fail("Invalid element ref.");
        const raw = await wv.executeJavaScript(
          `(() => { const el = ${refExpr}; if (!el) return ''; return (el.innerText || el.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 8000); })()`,
        );
        const text = typeof raw === "string" ? raw : "";
        return BrowserCommandResult.make({
          id: req.id,
          ok: true,
          url: safeCall(() => wv.getURL(), ""),
          title: safeCall(() => wv.getTitle(), ""),
          text: text.length > 0 ? text : "(no visible text)",
        });
      }
      case "History": {
        if (command.action === "back") {
          if (!safeCall(() => wv.canGoBack(), false)) {
            return fail("Can't go back — no earlier page in history.");
          }
          wv.goBack();
        } else if (command.action === "forward") {
          if (!safeCall(() => wv.canGoForward(), false)) {
            return fail("Can't go forward — no later page in history.");
          }
          wv.goForward();
        } else {
          wv.reload();
        }
        await waitForStop(wv);
        return BrowserCommandResult.make({
          id: req.id,
          ok: true,
          url: safeCall(() => wv.getURL(), ""),
          title: safeCall(() => wv.getTitle(), ""),
          detail: `Did ${command.action}.`,
        });
      }
      case "Console": {
        const log = hooks.readConsole();
        return BrowserCommandResult.make({
          id: req.id,
          ok: true,
          text: log,
        });
      }
      case "Login": {
        // Pull the dummy secret out-of-band (renderer-only RPC) and inject it
        // straight into the page. The password never returns to the agent —
        // only the ok/detail below, which omit it.
        const client = await getRpcClient();
        const secret = await Effect.runPromise(
          client.browser.fillForOrigin({ origin: command.origin }),
        );
        if (secret === null) {
          return fail(
            `No saved credential for ${command.origin}. Add a dummy login in Settings → Browser.`,
          );
        }
        const res = await runJsObject(
          wv,
          `(() => { const U = ${JSON.stringify(secret.username)}; const P = ${JSON.stringify(secret.password)}; const pw = document.querySelector('input[type="password"]'); if (!pw) return JSON.stringify({ ok:false, error:'No password field on this page — navigate to the login form first.' }); let user = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]'); if (!user) { user = Array.from(document.querySelectorAll('input')).find((i) => /^(text|email|)$/.test(i.type)) || null; } const setVal = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value'); if (d && d.set) d.set.call(el, v); else el.value = v; el.dispatchEvent(new Event('input', { bubbles:true })); el.dispatchEvent(new Event('change', { bubbles:true })); }; if (user) setVal(user, U); setVal(pw, P); const form = pw.form; if (form && typeof form.requestSubmit === 'function') { try { form.requestSubmit(); return JSON.stringify({ ok:true, detail:'Filled and submitted the login form.' }); } catch (e) {} } pw.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', keyCode:13, which:13, bubbles:true })); return JSON.stringify({ ok:true, detail:'Filled the saved credentials and pressed Enter.' }); })()`,
        );
        return resultFromJs(req.id, res, "Submitted the saved login.");
      }
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// Snapshot refs are minted as `e<number>` — validate before string-injecting
// into a querySelector so a crafted ref can't break out of the selector.
const isValidRef = (ref: string): boolean => /^e\d+$/.test(ref);

/**
 * Resolve a snapshot ref to webview-relative pixel coords + a short label.
 * Scrolls the element into view first so the agent's click can't miss because
 * it scrolled out between snapshot and action. The label drives the human-
 * readable detail strings ("Clicked Sign in"); we read it page-side because
 * it's cheaper than copying the snapshot back across the bridge.
 *
 * Returns null when the ref no longer matches anything (snapshot is stale).
 */
async function resolveRefRect(
  wv: WebviewElement,
  ref: string,
): Promise<{ cx: number; cy: number; label: string } | null> {
  const raw = await wv.executeJavaScript(
    `(() => { const el = document.querySelector('[data-mz-ref=${JSON.stringify(ref)}]'); if (!el) return null; el.scrollIntoView({ block:'center', inline:'center' }); const r = el.getBoundingClientRect(); const label = ((el.innerText||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.tagName)||'').replace(/\\s+/g,' ').trim().slice(0,60); return JSON.stringify({ cx: r.left + r.width/2, cy: r.top + r.height/2, label }); })()`,
  );
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as {
      cx: number;
      cy: number;
      label: string;
    };
    if (
      typeof parsed.cx !== "number" ||
      typeof parsed.cy !== "number" ||
      !Number.isFinite(parsed.cx) ||
      !Number.isFinite(parsed.cy)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Send one CDP input action through the preload bridge. Returns false if
 * the bridge isn't present (renderer running outside Electron) or main
 * reports the dispatch failed (debugger not attached, webContents destroyed).
 */
async function dispatchInput(
  webContentsId: number,
  action: BrowserInputAction,
): Promise<boolean> {
  const bridge = window.memoize?.browser;
  if (bridge === undefined) return false;
  try {
    return await bridge.dispatchInput(webContentsId, action);
  } catch {
    return false;
  }
}

/**
 * Move-then-press-then-release at (x, y). Waits the cursor's glide duration
 * between the move and the press so the visible click pulse lands at the
 * destination, not somewhere mid-glide. The two-event press/release pair is
 * what makes pages see a "real" click (vs `el.click()`, which fires only a
 * synthetic `click` event and skips mousedown/mouseup).
 */
async function dispatchClickViaCdp(
  webContentsId: number,
  x: number,
  y: number,
): Promise<boolean> {
  const moved = await dispatchInput(webContentsId, {
    type: "mouseMove",
    x,
    y,
  });
  if (!moved) return false;
  await delay(CURSOR_GLIDE_MS);
  await dispatchInput(webContentsId, {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  // A few ms between press/release looks more natural to long-press
  // detectors and matches real-mouse cadence. Most pages don't care.
  await delay(15);
  await dispatchInput(webContentsId, {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  return true;
}

/**
 * Tap a named key (`Enter`, `Tab`, `Escape`, `ArrowDown`, …) via CDP on the
 * focused element. `text` is set for printable single chars so the page sees
 * a real `input` event in `<textarea>`/contenteditable; non-printable keys
 * (Enter, arrows) leave `text` blank, mirroring Chromium's own handling.
 */
async function dispatchKeyTap(webContentsId: number, key: string): Promise<void> {
  const isPrintable = key.length === 1;
  const payload: BrowserInputAction = {
    type: "keyDown",
    key,
    ...(isPrintable ? { text: key } : {}),
  };
  await dispatchInput(webContentsId, payload);
  await dispatchInput(webContentsId, {
    type: "keyUp",
    key,
  });
}

/** Run page JS that returns a JSON string and parse it; null on any failure. */
async function runJsObject(
  wv: WebviewElement,
  code: string,
): Promise<{ ok: boolean; error?: string; detail?: string } | null> {
  const raw = await wv.executeJavaScript(code);
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as { ok: boolean; error?: string; detail?: string };
  } catch {
    return null;
  }
}

const resultFromJs = (
  id: string,
  res: { ok: boolean; error?: string; detail?: string } | null,
  fallbackDetail: string,
): BrowserCommandResult =>
  res === null
    ? BrowserCommandResult.make({
        id,
        ok: false,
        error: "The page did not respond to the action.",
      })
    : BrowserCommandResult.make({
        id,
        ok: res.ok,
        ...(res.ok
          ? { detail: res.detail ?? fallbackDetail }
          : { error: res.error ?? "Action failed." }),
      });

/**
 * Page-side DOM snapshot. Clears stale refs, then tags every visible
 * interactive element with a fresh `data-mz-ref` and returns a compact JSON
 * array `[{ ref, role, name, value, tag }]` for the agent to target.
 */
const SNAPSHOT_JS = `(() => {
  document.querySelectorAll('[data-mz-ref]').forEach((e) => e.removeAttribute('data-mz-ref'));
  const sel = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="tab"], [role="menuitem"], [onclick], [contenteditable="true"]';
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0.05 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight + 400;
    if (!visible) continue;
    if (el.disabled) continue;
    const ref = 'e' + (++i);
    el.setAttribute('data-mz-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag);
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.innerText || '').trim() || el.getAttribute('name') || el.getAttribute('title') || el.getAttribute('value') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const value = (el.value != null ? String(el.value) : '').slice(0, 80);
    out.push({ ref, role, name, value, tag });
    if (out.length >= 200) break;
  }
  return JSON.stringify(out);
})()`;

/**
 * Page-side rAF smooth-scroll loop. Cubic ease-in-out over a fixed duration
 * so the animation looks identical on every site — `window.scrollTo({behavior:
 * 'smooth'})` honors per-site `scroll-behavior` overrides and finishes faster
 * than the user can read what passed, which is why this exists.
 */
const SMOOTH_SCROLL_BODY = `
  const start = window.scrollY;
  const dist = targetY - start;
  if (Math.abs(dist) < 2) { window.scrollTo(0, targetY); return; }
  const dur = ${SMOOTH_SCROLL_MS};
  const t0 = performance.now();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function step(now) {
    const p = Math.min(1, (now - t0) / dur);
    window.scrollTo(0, start + dist * ease(p));
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
`;

const buildSmoothScrollRefJs = (ref: string): string =>
  `(() => { const el = document.querySelector('[data-mz-ref=${JSON.stringify(ref)}]'); if (!el) return JSON.stringify({ ok:false, error:'No element with that ref — re-snapshot first.' }); const r = el.getBoundingClientRect(); const targetY = Math.max(0, window.scrollY + r.top - (window.innerHeight - r.height) / 2); ${SMOOTH_SCROLL_BODY} return JSON.stringify({ ok:true, detail:'Scrolled element into view.' }); })()`;

const buildSmoothScrollDirJs = (
  dir: "up" | "down" | "top" | "bottom",
): string => {
  if (dir === "top") {
    return `(() => { window.scrollTo({ top:0, behavior:'instant' }); return JSON.stringify({ ok:true, detail:'Scrolled top.' }); })()`;
  }
  if (dir === "bottom") {
    return `(() => { window.scrollTo({ top:document.body.scrollHeight, behavior:'instant' }); return JSON.stringify({ ok:true, detail:'Scrolled bottom.' }); })()`;
  }
  const sign = dir === "up" ? -1 : 1;
  return `(() => { const h = window.innerHeight; const targetY = Math.max(0, Math.min(document.body.scrollHeight - h, window.scrollY + ${sign} * Math.round(h * 0.85))); ${SMOOTH_SCROLL_BODY} const willHitBottom = ${sign} === 1 && targetY + h >= document.body.scrollHeight - 4; return JSON.stringify({ ok:true, detail:'Scrolled ${dir}' + (willHitBottom ? ' (reached bottom).' : '.') }); })()`;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const safeCall = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/**
 * Load a URL and resolve once the page settles (or a 20s cap, so a hung load
 * can't pin the agent's command). Resolves on the first `did-stop-loading`
 * or `did-fail-load` after the load starts.
 */
/** Wait for the next `did-stop-loading` (or a 15s cap) after a history nav. */
function waitForStop(wv: WebviewElement): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      wv.removeEventListener("did-stop-loading", finish);
      wv.removeEventListener("did-fail-load", finish);
      resolve();
    };
    wv.addEventListener("did-stop-loading", finish);
    wv.addEventListener("did-fail-load", finish);
    setTimeout(finish, 15000);
  });
}

function loadAndWait(wv: WebviewElement, url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      wv.removeEventListener("did-stop-loading", finish);
      wv.removeEventListener("did-fail-load", finish);
      resolve();
    };
    wv.addEventListener("did-stop-loading", finish);
    wv.addEventListener("did-fail-load", finish);
    try {
      void wv.loadURL(url).catch(() => finish());
    } catch {
      wv.src = url;
    }
    setTimeout(finish, 20000);
  });
}

function ToolbarButton({
  onClick,
  disabled,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    >
      {children}
    </button>
  );
}

// Best-effort URL normalization: a string with a scheme passes through,
// bare host[:port][/path] becomes https://… (except localhost / IP literals
// which default to http so dev servers work without typing the scheme).
function resolveUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(
    trimmed,
  );
  return `${isLocal ? "http" : "https"}://${trimmed}`;
}

// Minimal surface of Electron's WebviewTag we actually use. Keeps the file
// free of an `electron` import in the renderer (renderer is sandboxed and
// imports from `electron` would land us in preload territory).
type WebviewElement = HTMLElement & {
  src: string;
  loadURL: (url: string) => Promise<void>;
  reload: () => void;
  stop: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
  getTitle: () => string;
  /**
   * The embedded webContents id used by `webContents.fromId` on the main
   * side. Required so main can attach CDP and route real input events.
   */
  getWebContentsId: () => number;
  capturePage: () => Promise<NativeImageLike>;
  executeJavaScript: (code: string) => Promise<unknown>;
};

// Minimal surface of Electron's NativeImage we touch from the renderer.
// `toDataURL` keeps us off `Buffer`, which the sandboxed renderer lacks.
type NativeImageLike = {
  toDataURL: () => string;
  isEmpty: () => boolean;
};
