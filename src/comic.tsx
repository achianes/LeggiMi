// Comic UI kit shared by every LeggiMi screen: the Pay & Plan look
// (flat fills, fat ink outlines, hard offset shadows, poster lettering).
import React from "react";
import { View, Text, Pressable, StyleProp, ViewStyle, TextStyle } from "react-native";

export type ThemeName = "dark" | "light" | "sepia";

// ---- the comic palette (shared with Pay & Plan) ---------------------------
export const INK = "#17161A";
export const CREAM = "#FFF6E5";
export const PAPER = "#FFFDF7";
export const YELLOW = "#FFD93D";
export const CORAL = "#FF6B6B";
export const MINT = "#6BCB77";
export const SKY = "#4D96FF";
export const GRAPE = "#B983FF";
export const TANGERINE = "#FF9F45";
export const AQUA = "#4ECDC4";
export const BUBBLEGUM = "#FF9CEE";

// Font files live in android/app/src/main/assets/fonts; on Android the family
// name is the file name without extension.
export const FONT_POSTER = "LuckiestGuy-Regular";
export const FONT_BODY = "ComicNeue-Regular";
export const FONT_BOLD = "ComicNeue-Bold";

export type Palette = {
  bg: string;
  surface: string;
  surface2: string;
  text: string;
  dim: string;
  ink: string; // outline colour
  shadow: string; // hard offset shadow colour
  hlBg: string;
  hlText: string;
  statusBar: "light-content" | "dark-content";
};

export const THEMES: Record<ThemeName, Palette> = {
  light: {
    bg: CREAM,
    surface: PAPER,
    surface2: "#FFEFCB",
    text: INK,
    dim: "#6F6862",
    ink: INK,
    shadow: INK,
    hlBg: YELLOW,
    hlText: INK,
    statusBar: "dark-content",
  },
  sepia: {
    bg: "#F1E2C4",
    surface: "#FBF2DE",
    surface2: "#EBD9B3",
    text: "#2B2216",
    dim: "#7D6B4C",
    ink: "#2B2216",
    shadow: "#2B2216",
    hlBg: "#FFD06B",
    hlText: "#2B2216",
    statusBar: "dark-content",
  },
  dark: {
    bg: "#1E1C22",
    surface: "#2C2A32",
    surface2: "#3A3741",
    text: CREAM,
    dim: "#B8B1A5",
    ink: CREAM,
    shadow: "#08070A",
    hlBg: YELLOW,
    hlText: INK,
    statusBar: "light-content",
  },
};

// =====================================================================
// COMIC UI: flat fill + fat ink outline + hard offset shadow.
// Same recipe as Pay & Plan's ComicUi.kt, rebuilt with React Native views.
// =====================================================================

type ComicBoxProps = {
  children?: React.ReactNode;
  palette: Palette;
  color?: string;
  radius?: number;
  stroke?: number;
  shadow?: number;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  onPress?: () => void;
  disabled?: boolean;
  hitSlop?: number;
};

export function ComicBox({
  children, palette, color, radius = 20, stroke = 3, shadow = 5, style, contentStyle, onPress, disabled, hitSlop,
}: ComicBoxProps) {
  const bg = color ?? palette.surface;
  const render = (pressed: boolean) => {
    const drop = pressed && onPress && !disabled ? 1 : shadow;
    return (
      <>
        {shadow > 0 && (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: drop,
              left: drop,
              right: -drop,
              bottom: -drop,
              backgroundColor: palette.shadow,
              borderRadius: radius,
            }}
          />
        )}
        <View
          style={[
            { backgroundColor: bg, borderWidth: stroke, borderColor: palette.ink, borderRadius: radius, overflow: "hidden" },
            contentStyle,
          ]}
        >
          {children}
        </View>
      </>
    );
  };

  if (!onPress) {
    return <View style={[style, disabled && { opacity: 0.45 }]}>{render(false)}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        style,
        disabled && { opacity: 0.45 },
        pressed && !disabled ? { transform: [{ translateX: shadow - 1 }, { translateY: shadow - 1 }] } : null,
      ]}
    >
      {({ pressed }) => render(pressed)}
    </Pressable>
  );
}

type ComicButtonProps = {
  text: string;
  onPress: () => void;
  palette: Palette;
  color?: string;
  icon?: string;
  disabled?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

export function ComicButton({ text, onPress, palette, color = CORAL, icon, disabled, compact, style, textStyle }: ComicButtonProps) {
  return (
    <ComicBox
      palette={palette}
      color={color}
      radius={compact ? 14 : 18}
      shadow={compact ? 4 : 5}
      onPress={onPress}
      disabled={disabled}
      style={style}
      contentStyle={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: compact ? 12 : 18,
        paddingVertical: compact ? 8 : 12,
      }}
    >
      {icon ? <Text style={{ fontSize: compact ? 15 : 18, marginRight: 6 }}>{icon}</Text> : null}
      <Text
        numberOfLines={1}
        style={[
          { fontFamily: FONT_BOLD, fontSize: compact ? 13 : 16, color: INK, letterSpacing: 0.5 },
          textStyle,
        ]}
      >
        {text}
      </Text>
    </ComicBox>
  );
}

type ComicIconButtonProps = {
  icon: string;
  onPress: () => void;
  palette: Palette;
  color?: string;
  size?: number;
  disabled?: boolean;
  fontSize?: number;
  iconColor?: string;
  style?: StyleProp<ViewStyle>;
};

export function ComicIconButton({ icon, onPress, palette, color, size = 46, disabled, fontSize, iconColor, style }: ComicIconButtonProps) {
  return (
    <ComicBox
      palette={palette}
      color={color ?? palette.surface}
      radius={size / 2}
      shadow={4}
      onPress={onPress}
      disabled={disabled}
      style={style}
      contentStyle={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      <Text style={{ fontSize: fontSize ?? size * 0.44, color: iconColor ?? (color ? INK : palette.text), fontFamily: FONT_BOLD, includeFontPadding: false }}>
        {icon}
      </Text>
    </ComicBox>
  );
}

type ComicChipProps = { text: string; selected: boolean; onPress: () => void; palette: Palette; color?: string; style?: StyleProp<ViewStyle> };

export function ComicChip({ text, selected, onPress, palette, color = SKY, style }: ComicChipProps) {
  return (
    <ComicBox
      palette={palette}
      color={selected ? color : palette.surface}
      radius={14}
      stroke={selected ? 3 : 2}
      shadow={selected ? 4 : 2}
      onPress={onPress}
      style={style}
      contentStyle={{ paddingHorizontal: 14, paddingVertical: 8 }}
    >
      <Text numberOfLines={1} style={{ fontFamily: FONT_BOLD, fontSize: 14, color: selected ? INK : palette.text, letterSpacing: 0.3 }}>
        {text}
      </Text>
    </ComicBox>
  );
}

export function PosterTitle({ text, palette, size = 28, color, style }: { text: string; palette: Palette; size?: number; color?: string; style?: StyleProp<TextStyle> }) {
  return (
    <Text
      numberOfLines={1}
      style={[
        { fontFamily: FONT_POSTER, fontSize: size, lineHeight: Math.round(size * 1.15), color: color ?? palette.text, letterSpacing: 1, includeFontPadding: false },
        style,
      ]}
    >
      {text}
    </Text>
  );
}
