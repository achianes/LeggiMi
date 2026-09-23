// The voice as a little comic waveform: bars that follow the loudness of the
// natural voice (Piper reports it) or dance on their own for the system voice.
import React, { useEffect, useRef } from "react";
import { Animated, View } from "react-native";
import { piper } from "../speech/piper";

type Props = {
  /** true while the voice speaks */
  active: boolean;
  /** true when the loudness comes from Piper; otherwise the bars animate on their own */
  live: boolean;
  color: string;
  height?: number;
  bars?: number;
  width?: number;
};

export default function Waveform({ active, live, color, height = 26, bars = 14, width = 96 }: Props) {
  const vals = useRef(Array.from({ length: bars }, () => new Animated.Value(0.15))).current;
  const levelRef = useRef(0);

  useEffect(() => {
    if (!active) {
      vals.forEach((v) => Animated.timing(v, { toValue: 0.15, duration: 250, useNativeDriver: false }).start());
      return;
    }
    let unsub: (() => void) | null = null;
    if (live) unsub = piper.onLevel((l) => { levelRef.current = l; });
    let phase = 0;
    const tick = setInterval(() => {
      phase += 0.9;
      // Piper: RMS is small (speech peaks ~0.15); the system voice gets a plausible wander
      const base = live ? Math.min(1, levelRef.current * 6) : 0.35 + 0.3 * Math.abs(Math.sin(phase * 0.6));
      if (live) levelRef.current *= 0.55; // decay when no new level arrives
      vals.forEach((v, i) => {
        // a bumpy outline, higher in the middle, with a ripple that runs along the bars
        const mid = 1 - Math.abs((i - (bars - 1) / 2) / ((bars - 1) / 2)) * 0.6;
        const ripple = 0.55 + 0.45 * Math.sin(phase * 1.3 + i * 0.9);
        const target = Math.max(0.1, Math.min(1, base * mid * ripple + (live ? 0 : (Math.random() - 0.5) * 0.2)));
        Animated.timing(v, { toValue: target, duration: 80, useNativeDriver: false }).start();
      });
    }, 70);
    return () => { clearInterval(tick); unsub?.(); };
  }, [active, live, vals]);

  const barW = Math.max(2, Math.floor(width / bars) - 2);
  return (
    <View style={{ width, height, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      {vals.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            width: barW,
            borderRadius: barW / 2,
            backgroundColor: color,
            height: v.interpolate({ inputRange: [0, 1], outputRange: [3, height] }),
          }}
        />
      ))}
    </View>
  );
}
