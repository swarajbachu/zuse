import { useMemo, useState } from "react";
import { router } from "expo-router";
import { KeyboardAvoidingView, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "~/components/ui/button";
import { useConnectionsStore } from "~/store/connections";

/**
 * Manual "Add connection" form, presented as a native iOS form sheet (see the
 * `connect/manual` screen options in `app/_layout.tsx`). The old custom Modal
 * `Sheet` component is gone in favor of this route.
 */
export default function ManualConnectScreen() {
  const insets = useSafeAreaInsets();
  const add = useConnectionsStore((state) => state.add);
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("8787");
  const [token, setToken] = useState("");

  const canAdd = useMemo(
    () => host.trim().length > 0 && Number(port) > 0,
    [host, port]
  );

  const submit = async () => {
    if (!canAdd) return;
    await add({ host, port: Number(port), token });
    router.back();
  };

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 p-4"
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={{ borderCurve: "continuous" }}
          className="overflow-hidden rounded-2xl border border-border bg-card"
        >
          <Field
            label="Host"
            value={host}
            onChangeText={setHost}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="127.0.0.1"
          />
          <View className="ml-4 h-px bg-border" />
          <Field
            label="Port"
            value={port}
            onChangeText={setPort}
            keyboardType="number-pad"
            placeholder="8787"
          />
          <View className="ml-4 h-px bg-border" />
          <Field
            label="Token"
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Optional"
          />
        </View>

        <Button disabled={!canAdd} onPress={submit}>
          Save connection
        </Button>
      </ScrollView>
      <View style={{ height: insets.bottom }} />
    </KeyboardAvoidingView>
  );
}

function Field({
  label,
  ...props
}: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View className="min-h-[54px] flex-row items-center gap-3 px-4 py-2.5">
      <Text className="w-20 font-sans text-[17px] text-foreground">{label}</Text>
      <TextInput
        className="flex-1 font-sans text-[17px] text-foreground"
        placeholderTextColor="hsl(72 2% 64%)"
        {...props}
      />
    </View>
  );
}
