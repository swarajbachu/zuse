import {
  Alert01Icon,
  PlayIcon,
  SmartPhone01Icon,
  StopIcon,
} from "@hugeicons-pro/core-bulk-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";

import { useActiveContext } from "../store/active-workspace.ts";
import { useMobileStore } from "../store/mobile.ts";
import { BrowserShutter } from "./browser-shutter.tsx";
import { MobilePhoneFrame } from "./mobile-phone-frame.tsx";
import { Button } from "./ui/button.tsx";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { Spinner } from "./ui/spinner.tsx";

const BUSY = new Set(["detecting", "booting", "building", "launching"]);

export function MobilePane({ active }: { readonly active: boolean }) {
  const ctx = useActiveContext();
  const init = useMobileStore((s) => s.init);
  const availability = useMobileStore((s) => s.availability);
  const devices = useMobileStore((s) => s.devices);
  const selectedUdid = useMobileStore((s) => s.selectedUdid);
  const setSelectedUdid = useMobileStore((s) => s.setSelectedUdid);
  const refreshDevices = useMobileStore((s) => s.refreshDevices);
  const status = useMobileStore((s) => s.status);
  const log = useMobileStore((s) => s.log);
  const frameUrl = useMobileStore((s) => s.frameUrl);
  const shutterNonce = useMobileStore((s) => s.shutterNonce);
  const subscribeFrames = useMobileStore((s) => s.subscribeFrames);
  const unsubscribeFrames = useMobileStore((s) => s.unsubscribeFrames);
  const start = useMobileStore((s) => s.start);
  const stop = useMobileStore((s) => s.stop);
  const [logOpen, setLogOpen] = useState(true);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (active) subscribeFrames();
    else unsubscribeFrames();
  }, [active, subscribeFrames, unsubscribeFrames]);

  const selectedDevice = useMemo(
    () => devices.find((d) => d.udid === selectedUdid) ?? null,
    [devices, selectedUdid],
  );
  const busy = BUSY.has(status.phase);
  const canStart =
    ctx.status === "ready" &&
    !ctx.worktreePending &&
    selectedDevice !== null &&
    availability?.supported === true &&
    !busy;
  const canStop = status.phase !== "idle";

  const phaseTone =
    status.phase === "error"
      ? "bg-[var(--accent-red)]"
      : status.phase === "streaming"
        ? "bg-emerald-500"
        : busy
          ? "bg-amber-400"
          : "bg-muted-foreground/40";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <HugeiconsIcon
          icon={SmartPhone01Icon}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <Select
          value={selectedUdid ?? ""}
          onValueChange={(value) => setSelectedUdid(value === "" ? null : value)}
          disabled={devices.length === 0 || availability?.supported !== true}
        >
          <SelectTrigger size="sm" className="min-w-0 flex-1">
            <SelectValue placeholder="Choose simulator" />
          </SelectTrigger>
          <SelectPopup>
            {devices.map((device) => (
              <SelectItem key={device.udid} value={device.udid}>
                <span className="block truncate">
                  {device.name} · {device.runtime}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="sm"
          variant={status.phase === "streaming" ? "outline" : "default"}
          disabled={!canStart}
          loading={busy}
          onClick={() => {
            if (ctx.status === "ready" && selectedUdid !== null) {
              void start(ctx.rootPath, selectedUdid);
            }
          }}
        >
          <HugeiconsIcon icon={PlayIcon} />
          Start
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Stop mobile preview"
          disabled={!canStop}
          onClick={() => void stop()}
        >
          <HugeiconsIcon icon={StopIcon} />
        </Button>
      </header>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs text-muted-foreground">
        <span className={`size-2 rounded-full ${phaseTone}`} />
        <span className="capitalize">{status.phase}</span>
        {status.device !== undefined ? (
          <span className="min-w-0 truncate">· {status.device.name}</span>
        ) : null}
        <button
          type="button"
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] hover:bg-muted"
          onClick={() => void refreshDevices()}
        >
          Refresh
        </button>
      </div>
      {availability?.supported === false ? (
        <EmptyState
          icon="alert"
          title="Mobile preview unavailable"
          detail={availability.reason ?? "iOS Simulator preview requires macOS and Xcode."}
        />
      ) : devices.length === 0 && availability?.supported === true ? (
        <EmptyState
          icon="alert"
          title="No simulators installed"
          detail="Open Xcode settings and install an iOS runtime."
        />
      ) : ctx.status === "ready" && ctx.worktreePending ? (
        <EmptyState
          title="Waiting for worktree"
          detail="The Mobile panel will start once this chat's worktree path is ready."
        />
      ) : (
        <>
          {log.length > 0 || status.error !== undefined ? (
            <section className="shrink-0 border-b border-border/60">
              <button
                type="button"
                className="flex h-8 w-full items-center gap-2 px-3 text-left text-xs text-muted-foreground hover:bg-muted/45"
                onClick={() => setLogOpen((v) => !v)}
              >
                {busy ? <Spinner className="size-3" /> : null}
                <span className="font-medium text-foreground/80">
                  Build and launch log
                </span>
                <span className="ml-auto">{logOpen ? "Hide" : "Show"}</span>
              </button>
              {logOpen ? (
                <pre className="max-h-44 overflow-auto whitespace-pre-wrap px-3 pb-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {status.error !== undefined ? `${status.error}\n` : ""}
                  {log.slice(-120).join("\n")}
                </pre>
              ) : null}
            </section>
          ) : null}
          <MobilePhoneFrame frameUrl={frameUrl}>
            <BrowserShutter nonce={shutterNonce} />
          </MobilePhoneFrame>
        </>
      )}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  detail,
}: {
  readonly icon?: "alert";
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      {icon === "alert" ? (
        <HugeiconsIcon
          icon={Alert01Icon}
          className="size-5 text-muted-foreground"
        />
      ) : null}
      <p className="text-sm font-medium text-foreground/90">{title}</p>
      <p className="max-w-72 text-xs leading-relaxed text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

