import { NativeTabs } from "expo-router/unstable-native-tabs";

const BG = "hsl(72 5% 6%)";
const FG = "hsl(72 4% 92%)";
const MUTED = "hsl(72 2% 64%)";
const ACCENT = "hsl(72 98% 54%)";

export default function TabsLayout() {
  return (
    <NativeTabs
      minimizeBehavior="onScrollDown"
      tintColor={ACCENT}
      backgroundColor={BG}
      iconColor={{ default: MUTED, selected: ACCENT }}
      labelStyle={{
        default: { color: MUTED },
        selected: { color: FG, fontWeight: "600" },
      }}
      blurEffect="systemChromeMaterialDark"
      shadowColor="transparent"
      disableTransparentOnScrollEdge={false}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon
          sf={{ default: "rectangle.stack", selected: "rectangle.stack.fill" }}
        />
        <NativeTabs.Trigger.Label>Connections</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="computers">
        <NativeTabs.Trigger.Icon sf="laptopcomputer" />
        <NativeTabs.Trigger.Label>Computers</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
