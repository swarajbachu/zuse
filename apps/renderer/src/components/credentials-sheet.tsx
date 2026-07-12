import { HugeiconsIcon } from "@hugeicons/react";
import { ViewIcon, ViewOffIcon } from "@hugeicons-pro/core-bulk-rounded";
import { useState } from "react";

import type { AgentAvailability, ProviderId } from "@zuse/contracts";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { useProvidersStore } from "../store/providers.ts";

export function CredentialsSheet() {
  const open = useProvidersStore((s) => s.credentialsOpen);
  const setOpen = useProvidersStore((s) => s.setCredentialsOpen);
  const availability = useProvidersStore((s) => s.availability);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>Settings · API keys</SheetTitle>
          <SheetDescription>
            Most users don&apos;t need this. Run <code>claude /login</code> or{" "}
            <code>codex login</code> in your terminal and Zuse Alpha uses those
            credentials automatically. API keys here are an advanced fallback,
            stored in your OS keychain and only sent to the provider&apos;s SDK.
          </SheetDescription>
        </SheetHeader>
        <SheetPanel>
          <div className="flex flex-col gap-4">
            {availability.map((a) => (
              <ProviderRow key={a.providerId} availability={a} />
            ))}
          </div>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}

function ProviderRow({ availability }: { availability: AgentAvailability }) {
  const setCredential = useProvidersStore((s) => s.setCredential);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const onSave = async (id: ProviderId) => {
    if (value.trim().length === 0) return;
    setBusy(true);
    setStatus(null);
    try {
      await setCredential(id, value.trim());
      setValue("");
      setStatus("Saved.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted p-3">
      <div className="flex items-center justify-between">
        <Label className="font-medium">{availability.displayName}</Label>
        <div className="flex items-center gap-2 text-xs">
          {availability.cliLoggedIn && (
            <span className="text-emerald-500">CLI logged in</span>
          )}
          <span
            className={
              availability.hasApiKey
                ? "text-emerald-500"
                : "text-muted-foreground"
            }
          >
            {availability.hasApiKey ? "API key set" : "no API key"}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={reveal ? "text" : "password"}
            placeholder="paste API key"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label={reveal ? "Hide key" : "Reveal key"}
            tabIndex={-1}
          >
            {reveal ? (
              <HugeiconsIcon icon={ViewOffIcon} className="size-3.5" />
            ) : (
              <HugeiconsIcon icon={ViewIcon} className="size-3.5" />
            )}
          </button>
        </div>
        <Button
          size="sm"
          onClick={() => void onSave(availability.providerId)}
          disabled={busy || value.trim().length === 0}
        >
          Save
        </Button>
      </div>
      {status !== null && (
        <p className="text-muted-foreground text-xs">{status}</p>
      )}
    </div>
  );
}
