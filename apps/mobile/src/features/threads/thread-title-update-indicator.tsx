import { memo } from "react";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/AppSymbol";

export const ThreadTitleUpdateIndicator = memo(function ThreadTitleUpdateIndicator(props: {
  readonly compact: boolean;
  readonly tintColorClassName: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityHint="Opens automatic title update history"
      accessibilityLabel="Title renamed automatically. View title updates"
      accessibilityRole="button"
      hitSlop={8}
      onPress={(event) => {
        event.stopPropagation();
        props.onPress();
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
    >
      <SymbolView
        name={{ ios: "sparkles", android: "auto_awesome" }}
        size={props.compact ? 15 : 13}
        tintColorClassName={props.tintColorClassName}
        type="monochrome"
      />
    </Pressable>
  );
});
