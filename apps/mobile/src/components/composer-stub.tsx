import type { SessionId } from "@zuse/wire";
import { Effect } from "effect";
import { Send, Square } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, TextInput, View } from "react-native";

import { interruptSession, makeTextInput, sendMessage } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import { Button } from "./ui/button";

export const ComposerStub = ({
  connection,
  sessionId,
}: {
  connection: WsProtocolOptions;
  sessionId: SessionId;
}) => {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const canSend = text.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSend) return;
    const value = text.trim();
    setText("");
    setBusy(true);
    try {
      await Effect.runPromise(
        sendMessage({
          connection,
          sessionId,
          input: makeTextInput(value),
        })
      );
    } finally {
      setBusy(false);
    }
  };

  const interrupt = async () => {
    setBusy(true);
    try {
      await Effect.runPromise(interruptSession({ connection, sessionId }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="border-t border-border p-3">
      <View className="flex-row items-end gap-2 rounded-lg border border-border bg-card p-2">
        <TextInput
          className="min-h-10 flex-1 px-2 py-2 font-sans text-base text-foreground"
          multiline
          placeholder="Message"
          placeholderTextColor="hsl(72 4% 56%)"
          value={text}
          onChangeText={setText}
        />
        <Button variant="secondary" disabled={busy} onPress={interrupt}>
          <Square size={16} color="hsl(72 4% 92%)" />
        </Button>
        <Button disabled={!canSend} onPress={submit}>
          {busy ? (
            <ActivityIndicator color="hsl(72 4% 8%)" />
          ) : (
            <Send size={16} color="hsl(72 4% 8%)" />
          )}
        </Button>
      </View>
    </View>
  );
};
