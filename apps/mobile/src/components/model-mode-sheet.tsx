import { BottomSheet, Host, Picker } from "@expo/ui";
import type { PermissionMode, ProviderId, RuntimeMode } from "@zuse/wire";
import { SlidersHorizontal } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";

import {
  defaultModelForProvider,
  modelOptionsForProvider,
  PERMISSION_OPTIONS,
  providerOptions,
  PROVIDER_LABEL,
  RUNTIME_OPTIONS,
} from "~/lib/model-options";
import { GlassSurface } from "./ui/glass-surface";

export type ModelModeValue = {
  providerId: ProviderId;
  model: string;
  runtimeMode: RuntimeMode;
  permissionMode: PermissionMode;
};

export function ModelModeTrigger({
  value,
  editable,
  open,
  onOpenChange,
  onChange,
}: {
  value: ModelModeValue;
  editable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: ModelModeValue) => void;
}) {
  const runtimeLabel =
    RUNTIME_OPTIONS.find((item) => item.value === value.runtimeMode)?.label ??
    value.runtimeMode;
  const permissionLabel =
    PERMISSION_OPTIONS.find((item) => item.value === value.permissionMode)
      ?.label ?? value.permissionMode;

  const updateProvider = (providerId: ProviderId) => {
    onChange({
      ...value,
      providerId,
      model: defaultModelForProvider(providerId),
    });
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Model and mode"
        onPress={() => onOpenChange(true)}
        className="h-10 flex-row items-center gap-2 rounded-xl border border-border bg-card-elevated px-3 active:opacity-75"
        style={{ borderCurve: "continuous" }}
      >
        <SlidersHorizontal size={15} color="hsl(72 98% 54%)" />
        <Text className="max-w-[132px] font-sans-medium text-[12px] text-foreground" numberOfLines={1}>
          {PROVIDER_LABEL[value.providerId]} / {compactModelLabel(value.model)}
        </Text>
      </Pressable>
      <BottomSheet
        isPresented={open}
        onDismiss={() => onOpenChange(false)}
        snapPoints={[{ fraction: 0.46 }, "half"]}
      >
        <Host seedColor="hsl(72 98% 54%)" colorScheme="dark">
          <View className="gap-4 px-5 pb-8 pt-4">
            <View className="gap-1">
              <Text className="font-sans-bold text-[20px] text-foreground">
                Model and mode
              </Text>
              <Text className="font-sans text-[13px] leading-5 text-muted-foreground">
                {editable
                  ? "These settings apply before the first message starts."
                  : "This chat has already started, so model picks are shown read-only."}
              </Text>
            </View>
            <GlassSurface style={{ gap: 12, padding: 14 }}>
              <Picker
                selectedValue={value.providerId}
                enabled={editable}
                appearance="menu"
                onValueChange={(next) => updateProvider(next as ProviderId)}
              >
                {providerOptions().map((item) => (
                  <Picker.Item
                    key={item.value}
                    label={item.label}
                    value={item.value}
                  />
                ))}
              </Picker>
              <Picker
                selectedValue={value.model}
                enabled={editable}
                appearance="menu"
                onValueChange={(next) =>
                  onChange({ ...value, model: String(next) })
                }
              >
                {modelOptionsForProvider(value.providerId).map((item) => (
                  <Picker.Item
                    key={item.value}
                    label={item.label}
                    value={item.value}
                  />
                ))}
              </Picker>
              <Picker
                selectedValue={value.runtimeMode}
                enabled={editable}
                appearance="menu"
                onValueChange={(next) =>
                  onChange({ ...value, runtimeMode: next as RuntimeMode })
                }
              >
                {RUNTIME_OPTIONS.map((item) => (
                  <Picker.Item
                    key={item.value}
                    label={item.label}
                    value={item.value}
                  />
                ))}
              </Picker>
              <Picker
                selectedValue={value.permissionMode}
                enabled={editable}
                appearance="menu"
                onValueChange={(next) =>
                  onChange({ ...value, permissionMode: next as PermissionMode })
                }
              >
                {PERMISSION_OPTIONS.map((item) => (
                  <Picker.Item
                    key={item.value}
                    label={item.label}
                    value={item.value}
                  />
                ))}
              </Picker>
            </GlassSurface>
            <View className="flex-row gap-2">
              <ModePill label={runtimeLabel} />
              <ModePill label={permissionLabel} />
            </View>
          </View>
        </Host>
      </BottomSheet>
    </>
  );
}

const ModePill = ({ label }: { label: string }) => (
  <View className="rounded-full bg-primary/15 px-3 py-1">
    <Text className="font-sans-medium text-[12px] text-primary">{label}</Text>
  </View>
);

const compactModelLabel = (model: string): string =>
  model.replace(/^claude-/, "").replace(/^gpt-/, "");
