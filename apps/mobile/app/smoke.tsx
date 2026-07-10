import { MessageEnvelope } from "@zuse/contracts";
import { CheckCircle2, CircleAlert } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Effect, Fiber, Result, Schema, Stream } from "effect";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { getConnectionClient } from "~/rpc/connection";

type Probe = {
  name: string;
  status: "pending" | "pass" | "fail";
  detail: string;
};

const initialProbes: Probe[] = [
  { name: "Capabilities", status: "pending", detail: "" },
  { name: "Schema decode", status: "pending", detail: "" },
  { name: "Effect stream", status: "pending", detail: "" },
  { name: "Live wire", status: "pending", detail: "" },
];

export default function SmokeScreen() {
  const [probes, setProbes] = useState(initialProbes);

  const update = (name: string, patch: Partial<Probe>) => {
    setProbes((current) =>
      current.map((probe) =>
        probe.name === name ? { ...probe, ...patch } : probe,
      ),
    );
  };

  const run = useCallback(async () => {
    setProbes(initialProbes);
    runCapabilityProbe(update);
    await runSchemaProbe(update);
    await runEffectProbe(update);
    await runLiveProbe(update);
  }, []);

  useEffect(() => {
    // Diagnostic harness: runs the probe suite once on mount. The initial
    // synchronous state reset is intentional and harmless here (single run).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run();
  }, [run]);

  return (
    <View className="flex-1 bg-background">
      <ScrollView contentContainerClassName="gap-3 p-4">
        {probes.map((probe) => (
          <Card key={probe.name}>
            <View className="flex-row items-center gap-3">
              {probe.status === "pass" ? (
                <CheckCircle2 size={18} color="hsl(72 98% 54%)" />
              ) : (
                <CircleAlert size={18} color="hsl(42 93% 56%)" />
              )}
              <Text className="flex-1 font-sans-medium text-base text-foreground">
                {probe.name}
              </Text>
              <Badge
                tone={
                  probe.status === "pass"
                    ? "primary"
                    : probe.status === "fail"
                      ? "danger"
                      : "warning"
                }
              >
                {probe.status}
              </Badge>
            </View>
            {probe.detail.length > 0 ? (
              <Text className="mt-3 font-mono text-xs leading-5 text-muted-foreground">
                {probe.detail}
              </Text>
            ) : null}
          </Card>
        ))}
      </ScrollView>
      <View className="border-t border-border p-4">
        <Button onPress={run}>Run again</Button>
      </View>
    </View>
  );
}

const runCapabilityProbe = (
  update: (name: string, patch: Partial<Probe>) => void,
) => {
  const report = {
    WebSocket: typeof globalThis.WebSocket,
    TextEncoder: typeof globalThis.TextEncoder,
    TextDecoder: typeof globalThis.TextDecoder,
    WeakRef: typeof globalThis.WeakRef,
    "Symbol.asyncIterator": typeof Symbol.asyncIterator,
    FinalizationRegistry: typeof globalThis.FinalizationRegistry,
    structuredClone: typeof globalThis.structuredClone,
  };
  const required =
    report.WebSocket === "function" &&
    report.TextEncoder === "function" &&
    report.TextDecoder === "function" &&
    report.WeakRef === "function" &&
    report["Symbol.asyncIterator"] === "symbol";
  update("Capabilities", {
    status: required ? "pass" : "fail",
    detail: JSON.stringify(report, null, 2),
  });
};

const runSchemaProbe = async (
  update: (name: string, patch: Partial<Probe>) => void,
) => {
  try {
    const valid = fixture("assistant", { _tag: "assistant", text: "hello" });
    const decoded = Schema.decodeUnknownResult(MessageEnvelope)(valid);
    const unknown = Schema.decodeUnknownResult(MessageEnvelope)(
      fixture("mystery", { _tag: "mystery", text: "nope" }),
    );
    if (Result.isFailure(decoded)) {
      throw new Error(String(decoded.failure));
    }
    if (Result.isSuccess(unknown)) {
      throw new Error("unknown _tag decoded unexpectedly");
    }
    Schema.encodeSync(MessageEnvelope)(decoded.success);
    update("Schema decode", {
      status: "pass",
      detail:
        "MessageEnvelope decode/encode passed; unknown _tag failed closed.",
    });
  } catch (cause) {
    update("Schema decode", { status: "fail", detail: errorText(cause) });
  }
};

const runEffectProbe = async (
  update: (name: string, patch: Partial<Probe>) => void,
) => {
  try {
    const values = await Effect.runPromise(
      Stream.range(1, 3).pipe(
        Stream.mapEffect((n) => Effect.succeed(n * 2)),
        Stream.runCollect,
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.never.pipe(Effect.forkChild);
        yield* Fiber.interrupt(fiber);
      }),
    );
    update("Effect stream", {
      status: "pass",
      detail: `Stream values: ${values.join(", ")}; interrupt passed.`,
    });
  } catch (cause) {
    update("Effect stream", { status: "fail", detail: errorText(cause) });
  }
};

const runLiveProbe = async (
  update: (name: string, patch: Partial<Probe>) => void,
) => {
  try {
    const client = await Effect.runPromise(
      getConnectionClient({ host: "127.0.0.1", port: 8787 }),
    );
    const ping = await Effect.runPromise(client["ping.ping"]({}));
    const projects = await Effect.runPromise(client["workspace.list"]({}));
    const firstProject = projects[0];
    let streamDetail = "no sessions available";
    if (firstProject !== undefined) {
      const sessions = await Effect.runPromise(
        client["session.list"]({ projectId: firstProject.id }),
      );
      const firstSession = sessions[0];
      if (firstSession !== undefined) {
        const envelopes = await Effect.runPromise(
          client["session.events"]({
            sessionId: firstSession.id,
            afterSequence: 0,
          }).pipe(Stream.take(3), Stream.runCollect),
        );
        streamDetail = `session ${firstSession.id}; sequences ${envelopes
          .map((envelope) => envelope.sequence)
          .join(", ")}`;
      }
    }
    update("Live wire", {
      status: "pass",
      detail: `${ping.message}; projects=${projects.length}; ${streamDetail}`,
    });
  } catch (cause) {
    update("Live wire", { status: "fail", detail: errorText(cause) });
  }
};

const fixture = (id: string, content: unknown) => ({
  sequence: 1,
  message: {
    id: `msg-${id}`,
    sessionId: "session-smoke",
    role: "assistant",
    content,
    createdAt: "2026-07-03T00:00:00.000Z",
  },
});

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : JSON.stringify(cause, null, 2);
