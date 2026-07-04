import { Modal, Pressable, Text, View } from "react-native";
import { X } from "lucide-react-native";

import { cn } from "~/lib/cn";
import { IconButton } from "./icon-button";

export const Sheet = ({
  visible,
  title,
  children,
  onClose
}: {
  visible: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) => (
  <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
    <View className="flex-1 justify-end bg-black/60">
      <Pressable className="flex-1" onPress={onClose} />
      <View className={cn("rounded-t-2xl border border-border bg-background p-4 pb-8")}>
        <View className="mb-4 flex-row items-center justify-between">
          <Text className="font-sans-medium text-lg text-foreground">{title}</Text>
          <IconButton icon={X} label="Close" onPress={onClose} />
        </View>
        {children}
      </View>
    </View>
  </Modal>
);
