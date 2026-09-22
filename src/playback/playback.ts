import { DeviceEventEmitter, NativeModules } from "react-native";

/**
 * Reading in the background: a media notification with controls (also on the
 * lock screen), headset buttons, audio focus (pause on a call, resume after),
 * wake lock. Backed by LeggiMiPlaybackService on Android.
 */
export type PlaybackAction = "play" | "pause" | "next" | "prev" | "stop" | `open:${string}`;

const native = NativeModules.LeggiMiPlayback as
  | {
      update(title: string, subtitle: string, playing: boolean): Promise<boolean>;
      stop(): Promise<boolean>;
      pending(): Promise<string | null>;
    }
  | undefined;

let shown = false;

export const playback = {
  /** show or refresh the card; `playing` also drives audio focus and the wake lock */
  async update(title: string, subtitle: string, playing: boolean) {
    if (!native) return;
    shown = true;
    try { await native.update(title, subtitle, playing); } catch {}
  },
  /** remove the card, release focus and wake lock */
  async stop() {
    if (!native || !shown) return;
    shown = false;
    try { await native.stop(); } catch {}
  },
  /** the action Android Auto sent while the app was closed (consumed once) */
  async pending(): Promise<PlaybackAction | null> {
    try { return ((await native?.pending()) as PlaybackAction) || null; } catch { return null; }
  },
  onAction(cb: (a: PlaybackAction) => void) {
    const sub = DeviceEventEmitter.addListener("playback-action", (a: string) => cb(a as PlaybackAction));
    return () => sub.remove();
  },
};
