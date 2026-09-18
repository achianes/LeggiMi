// Cloud accounts sheet: manage accounts (Settings) or pick one to upload a file.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Modal, Pressable, ScrollView, TextInput, ActivityIndicator, Alert, StyleSheet, Linking } from "react-native";
import {
  INK, YELLOW, CORAL, MINT, FONT_BODY, FONT_BOLD, Palette,
  ComicBox, ComicButton, ComicIconButton, ComicChip, PosterTitle,
} from "../comic";
import {
  CloudAccount, CloudProvider, PROVIDERS, PROVIDER_ORDER, loadAccounts, saveAccounts, cloudNative, fmtSpace,
} from "./cloud";

export type UploadFile = { path: string; name: string; mime: string };

type Props = {
  visible: boolean;
  palette: Palette;
  bottomInset: number;
  /** when set, the sheet asks where to upload this file */
  file?: UploadFile | null;
  /** called after a successful upload (e.g. "move to cloud" then removes the local copy) */
  onUploaded?: () => void;
  onClose: () => void;
};

type Screen = { kind: "list" } | { kind: "providers" } | { kind: "form"; provider: CloudProvider };

export default function CloudSheet({ visible, palette, bottomInset, file, onUploaded, onClose }: Props) {
  const [accounts, setAccounts] = useState<CloudAccount[]>([]);
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [busy, setBusy] = useState<string | null>(null);
  // each network operation gets a number; cancelling bumps it so late answers are ignored
  const opRef = useRef(0);
  const cancelBusy = () => {
    opRef.current++;
    cloudNative.cancel().catch(() => {});
    setBusy(null);
  };
  // form fields
  const [server, setServer] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [urlIdx, setUrlIdx] = useState(0);
  const [appKey, setAppKey] = useState("");
  const s = useMemo(() => makeStyles(palette), [palette]);

  const persist = async (list: CloudAccount[]) => {
    setAccounts(list);
    await saveAccounts(list);
  };

  useEffect(() => {
    if (!visible) return;
    setScreen({ kind: "list" });
    loadAccounts().then(setAccounts);
  }, [visible]);

  const refresh = useCallback(async (a: CloudAccount) => {
    setBusy("Checking the free space…");
    const op = ++opRef.current;
    try {
      const r = await cloudNative.info(a.id);
      if (op !== opRef.current) return;
      const list = (await loadAccounts()).map((x) =>
        x.id === a.id ? { ...x, free: r.free, total: r.total, used: r.used, checkedAt: Date.now() } : x
      );
      await persist(list);
    } catch (e: any) {
      if (op !== opRef.current) return;
      const msg = String(e?.message ?? e);
      if (!/cancel/i.test(msg)) Alert.alert(PROVIDERS[a.provider].name, msg);
    } finally {
      if (op === opRef.current) setBusy(null);
    }
  }, []);

  const resetForm = () => {
    setServer("");
    setUser("");
    setPass("");
    setUrlIdx(0);
  };

  const connect = async (p: CloudProvider) => {
    const info = PROVIDERS[p];
    if (!cloudNative.available()) {
      Alert.alert("Cloud", "This build has no cloud module. Install the latest LeggiMi build.");
      return;
    }
    let url = "";
    if (info.auth === "webdav") {
      if (info.server === "ask") {
        if (!server.trim() || !user.trim()) { Alert.alert(info.name, "Enter the server address and the user name."); return; }
        url = info.buildUrl!(server, user.trim());
      } else if (info.server === "full") {
        if (!server.trim()) { Alert.alert(info.name, "Enter the WebDAV address."); return; }
        url = server.trim();
      } else {
        url = info.urls![urlIdx]?.url ?? info.urls![0].url;
      }
      if (!user.trim() || !pass) { Alert.alert(info.name, "Enter user name and password."); return; }
    }
    if (info.auth === "dropbox" && !appKey.trim()) {
      Alert.alert("Dropbox", "Paste the App key of your Dropbox app.");
      return;
    }
    setBusy(info.auth === "webdav" ? "Checking the login and the free space…" : "Waiting for the sign-in…");
    const op = ++opRef.current;
    try {
      const r =
        info.auth === "google"
          ? await cloudNative.googleConnect()
          : info.auth === "dropbox"
          ? await cloudNative.dropboxConnect(appKey.trim())
          : await cloudNative.webdavConnect(url, user.trim(), pass, user.trim());
      if (op !== opRef.current) return;
      const acc: CloudAccount = {
        id: r.id,
        provider: p,
        label: r.label || user.trim() || info.name,
        addedAt: Date.now(),
        free: r.free,
        total: r.total,
        used: r.used,
        checkedAt: Date.now(),
      };
      await persist([...(await loadAccounts()), acc]);
      resetForm();
      setScreen({ kind: "list" });
      Alert.alert(info.name, `Connected. The folder “LeggiMi” is ready.\n${fmtSpace(acc)}.`);
    } catch (e: any) {
      if (op !== opRef.current) return;
      const msg = String(e?.message ?? e);
      if (!/cancel/i.test(msg)) Alert.alert(info.name, msg);
    } finally {
      if (op === opRef.current) setBusy(null);
      setPass("");
    }
  };

  const removeAccount = (a: CloudAccount) => {
    Alert.alert("Remove account", `Forget ${PROVIDERS[a.provider].name} · ${a.label}? Files already uploaded stay in the cloud.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          await cloudNative.remove(a.id).catch(() => {});
          await persist((await loadAccounts()).filter((x) => x.id !== a.id));
        },
      },
    ]);
  };

  const uploadTo = async (a: CloudAccount) => {
    if (!file) return;
    setBusy(`Uploading to ${PROVIDERS[a.provider].name}…`);
    const op = ++opRef.current;
    try {
      const r = await cloudNative.upload(a.id, file.path, file.name, file.mime);
      if (op !== opRef.current) return;
      const list = (await loadAccounts()).map((x) =>
        x.id === a.id ? { ...x, free: r.free, total: r.total, used: r.used, checkedAt: Date.now() } : x
      );
      await persist(list);
      setBusy(null);
      onUploaded?.();
      onClose();
      Alert.alert(onUploaded ? "Moved" : "Uploaded", `${r.path}\n${PROVIDERS[a.provider].name} · ${fmtSpace(r)}.`);
    } catch (e: any) {
      if (op !== opRef.current) return;
      setBusy(null);
      const msg = String(e?.message ?? e);
      if (!/cancel/i.test(msg)) Alert.alert(PROVIDERS[a.provider].name, msg);
    }
  };

  const back = () => {
    if (busy) { cancelBusy(); return; }
    if (screen.kind === "form") setScreen({ kind: "providers" });
    else if (screen.kind === "providers") setScreen({ kind: "list" });
    else onClose();
  };

  // ------------------------------------------------------------- render
  const title = screen.kind === "form" ? PROVIDERS[screen.provider].name.toUpperCase() : screen.kind === "providers" ? "ADD A CLOUD" : file ? "SAVE TO CLOUD" : "CLOUD ACCOUNTS";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={back}>
      <Pressable style={s.backdrop} onPress={back} />
      <View style={[s.wrap, { bottom: Math.max(12, bottomInset + 8) }]}>
        <ComicBox palette={palette} radius={26} shadow={6} contentStyle={s.sheet}>
          <View style={s.head}>
            {screen.kind !== "list" ? (
              <ComicIconButton icon="‹" onPress={back} palette={palette} color={palette.surface2} size={36} fontSize={20} />
            ) : (
              <Text style={{ fontSize: 26 }}>☁️</Text>
            )}
            <PosterTitle text={title} palette={palette} size={24} style={{ flex: 1 }} />
          </View>

          {screen.kind === "list" ? (
            <>
              <Text style={s.hint}>
                {file
                  ? `Where should “${file.name}” go? It lands in the LeggiMi folder, after checking the free space.`
                  : "Exports go into a folder called “LeggiMi”. Passwords and tokens are encrypted on this phone."}
              </Text>
              <ScrollView style={{ flexGrow: 0, marginTop: 10 }} showsVerticalScrollIndicator={false}>
                {accounts.map((a) => {
                  const pInfo = PROVIDERS[a.provider];
                  const pct = a.total > 0 ? Math.min(100, Math.round((a.used / a.total) * 100)) : 0;
                  return (
                    <ComicBox
                      key={a.id}
                      palette={palette}
                      radius={16}
                      stroke={2}
                      shadow={3}
                      onPress={file ? () => uploadTo(a) : () => refresh(a)}
                      style={s.item}
                      contentStyle={s.row}
                    >
                      <View style={[s.icon, { backgroundColor: pInfo.color, borderColor: palette.ink }]}>
                        <Text style={{ fontSize: 20 }}>{pInfo.icon}</Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={s.name}>{pInfo.name}</Text>
                        <Text numberOfLines={1} style={s.meta}>{a.label}</Text>
                        <Text numberOfLines={1} style={s.meta}>{fmtSpace(a)}</Text>
                        {a.total > 0 ? (
                          <View style={[s.track, { borderColor: palette.ink }]}>
                            <View style={[s.fill, { width: `${Math.max(pct, 2)}%`, backgroundColor: pct > 90 ? CORAL : MINT }]} />
                          </View>
                        ) : null}
                      </View>
                      {file ? (
                        <Text style={{ fontSize: 24 }}>⬆️</Text>
                      ) : (
                        <ComicIconButton icon="✕" onPress={() => removeAccount(a)} palette={palette} color={palette.surface2} size={30} fontSize={13} />
                      )}
                    </ComicBox>
                  );
                })}
                {!accounts.length ? <Text style={s.hint}>No cloud account yet.</Text> : null}
              </ScrollView>
              <ComicButton text="ADD ACCOUNT" icon="➕" onPress={() => setScreen({ kind: "providers" })} palette={palette} color={YELLOW} style={{ marginTop: 12 }} />
              <ComicButton text="CLOSE" onPress={onClose} palette={palette} color={CORAL} compact style={{ marginTop: 10 }} />
            </>
          ) : null}

          {screen.kind === "providers" ? (
            <ScrollView style={{ flexGrow: 0, marginTop: 6 }} showsVerticalScrollIndicator={false}>
              {PROVIDER_ORDER.map((p) => {
                const pInfo = PROVIDERS[p];
                return (
                  <ComicBox
                    key={p}
                    palette={palette}
                    radius={16}
                    stroke={2}
                    shadow={3}
                    onPress={() => { resetForm(); setScreen({ kind: "form", provider: p }); }}
                    style={s.item}
                    contentStyle={s.row}
                  >
                    <View style={[s.icon, { backgroundColor: pInfo.color, borderColor: palette.ink }]}>
                      <Text style={{ fontSize: 20 }}>{pInfo.icon}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.name}>{pInfo.name}</Text>
                      <Text style={s.meta}>{pInfo.auth === "webdav" ? "user name + password" : "sign in with the provider"}</Text>
                    </View>
                  </ComicBox>
                );
              })}
            </ScrollView>
          ) : null}

          {screen.kind === "form" ? (
            <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {(() => {
                const pInfo = PROVIDERS[screen.provider];
                return (
                  <>
                    <Text style={s.hint}>{pInfo.hint}</Text>
                    {pInfo.auth === "webdav" ? (
                      <>
                        {pInfo.server === "ask" || pInfo.server === "full" ? (
                          <>
                            <Text style={s.label}>{pInfo.server === "full" ? "WebDAV address" : "Server"}</Text>
                            <TextInput
                              value={server}
                              onChangeText={setServer}
                              style={s.input}
                              autoCapitalize="none"
                              autoCorrect={false}
                              keyboardType="url"
                              placeholder={pInfo.server === "full" ? "https://nas.local:5006/" : "cloud.example.com"}
                              placeholderTextColor={palette.dim}
                            />
                          </>
                        ) : null}
                        {pInfo.urls && pInfo.urls.length > 1 ? (
                          <View style={s.chips}>
                            {pInfo.urls.map((u, i) => (
                              <ComicChip key={u.url} text={u.label} selected={urlIdx === i} onPress={() => setUrlIdx(i)} palette={palette} color={YELLOW} />
                            ))}
                          </View>
                        ) : null}
                        <Text style={s.label}>{pInfo.userLabel ?? "User name"}</Text>
                        <TextInput value={user} onChangeText={setUser} style={s.input} autoCapitalize="none" autoCorrect={false} placeholderTextColor={palette.dim} />
                        <Text style={s.label}>{pInfo.passLabel ?? "Password"}</Text>
                        <TextInput value={pass} onChangeText={setPass} style={s.input} secureTextEntry autoCapitalize="none" autoCorrect={false} />
                      </>
                    ) : null}
                    {pInfo.auth === "dropbox" ? (
                      <>
                        <Text style={s.steps}>
                          1. Open dropbox.com/developers/apps › Create app › Scoped access › App folder.{"\n"}
                          2. Permissions: files.content.write, files.content.read, account_info.read.{"\n"}
                          3. Settings › Redirect URIs: add http://localhost:53682/{"\n"}
                          4. Copy the App key here and press Connect.
                        </Text>
                        <ComicButton
                          text="OPEN DROPBOX DEVELOPERS"
                          onPress={() => Linking.openURL("https://www.dropbox.com/developers/apps")}
                          palette={palette}
                          color={palette.surface2}
                          compact
                          style={{ marginTop: 8, alignSelf: "flex-start" }}
                        />
                        <Text style={s.label}>App key</Text>
                        <TextInput value={appKey} onChangeText={setAppKey} style={s.input} autoCapitalize="none" autoCorrect={false} />
                      </>
                    ) : null}
                    <ComicButton text="CONNECT" icon="🔗" onPress={() => connect(screen.provider)} palette={palette} color={MINT} style={{ marginTop: 16 }} />
                  </>
                );
              })()}
            </ScrollView>
          ) : null}

          {busy ? (
            <View style={s.busy}>
              <ComicBox palette={palette} color={YELLOW} radius={20} shadow={5} contentStyle={s.busyCard}>
                <ActivityIndicator color={INK} size="large" />
                <Text style={s.busyText}>{busy}</Text>
                <ComicButton text="CANCEL" onPress={cancelBusy} palette={palette} color={CORAL} compact style={{ marginTop: 14 }} />
              </ComicBox>
            </View>
          ) : null}
        </ComicBox>
      </View>
    </Modal>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "#17161A99" },
    wrap: { position: "absolute", left: 12, right: 12, maxHeight: "90%" },
    sheet: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 18 },
    head: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
    hint: { color: p.dim, fontFamily: FONT_BODY, fontSize: 13.5, lineHeight: 19, marginTop: 4 },
    steps: { color: p.text, fontFamily: FONT_BODY, fontSize: 13.5, lineHeight: 20, marginTop: 10 },
    item: { marginBottom: 10, marginRight: 6 },
    row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
    icon: { width: 44, height: 44, borderRadius: 14, borderWidth: 3, alignItems: "center", justifyContent: "center" },
    name: { color: p.text, fontFamily: FONT_BOLD, fontSize: 15 },
    meta: { color: p.dim, fontFamily: FONT_BODY, fontSize: 12.5, marginTop: 1 },
    track: { marginTop: 6, height: 8, borderRadius: 5, borderWidth: 2, overflow: "hidden", backgroundColor: p.surface },
    fill: { height: "100%" },
    label: { color: p.text, fontFamily: FONT_BOLD, fontSize: 14, marginTop: 14, marginBottom: 6 },
    input: {
      borderWidth: 3,
      borderColor: p.ink,
      borderRadius: 14,
      backgroundColor: p.surface,
      color: p.text,
      fontFamily: FONT_BODY,
      fontSize: 16,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    chips: { flexDirection: "row", gap: 10, marginTop: 12 },
    busy: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: p.surface + "CC", borderRadius: 22 },
    busyCard: { alignItems: "center", paddingHorizontal: 22, paddingVertical: 18, minWidth: 220 },
    busyText: { color: INK, fontFamily: FONT_BOLD, fontSize: 14.5, marginTop: 10, textAlign: "center" },
  });
}
