import { Host } from "@expo/ui";
import {
  Button as NativeButton,
  HStack,
  Image,
  Menu,
  Spacer,
  Text,
} from "@expo/ui/swift-ui";
import {
  contentShape,
  foregroundColor,
  frame,
  font,
  shapes,
} from "@expo/ui/swift-ui/modifiers";

export type SelectorOption = {
  key: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
};

const WHITE = "#ffffff";
const CHEVRON = "#c9c9c7";

/**
 * A transparent new-chat selector row rendered entirely as a native SwiftUI
 * Menu: a white leading SF Symbol, a white label, a trailing up/down chevron.
 * The Host stretches to the row width (so the native menu measures a real width
 * — with an intrinsic/`flex-start` width it collapses and clips the icon +
 * hides the label). A trailing `Spacer` eats the leftover width so the icon ·
 * text · chevron cluster stays pinned to the LEFT (SwiftUI ignores the frame's
 * `leading` alignment for this custom menu label, so the Spacer does the work).
 * `contentShape` makes the whole stretched row a tap target.
 */
export function SelectorRow({
  symbol,
  label,
  options,
  disabled = false,
  emptyLabel = "None",
}: {
  symbol: string;
  label: string;
  options: readonly SelectorOption[];
  disabled?: boolean;
  emptyLabel?: string;
}) {
  return (
    <Host style={{ alignSelf: "stretch", height: 40 }} colorScheme="dark">
      <Menu
        label={
          <HStack
            spacing={8}
            modifiers={[
              frame({ maxWidth: 10000, height: 40, alignment: "leading" }),
              contentShape(shapes.rectangle()),
            ]}
          >
            <Image
              systemName={sf(symbol)}
              size={15}
              modifiers={[foregroundColor(WHITE)]}
            />
            <Text modifiers={[foregroundColor(WHITE), font({ size: 15 })]}>
              {label}
            </Text>
            <Image
              systemName={sf("chevron.up.chevron.down")}
              size={11}
              modifiers={[foregroundColor(CHEVRON)]}
            />
            <Spacer />
          </HStack>
        }
      >
        {disabled || options.length === 0 ? (
          <NativeButton label={emptyLabel} onPress={() => {}} />
        ) : (
          options.map((option) => (
            <NativeButton
              key={option.key}
              label={option.label}
              systemImage={option.selected ? sf("checkmark") : undefined}
              onPress={option.onSelect}
            />
          ))
        )}
      </Menu>
    </Host>
  );
}

const sf = (name: string) => name as never;
