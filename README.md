# LeggiMi

**Listen to your documents.** LeggiMi is an offline text‑to‑speech reader for Android: open (or *share*) a PDF, Word, TXT or RTF file and it reads it aloud, highlighting each sentence as it goes — like karaoke for documents.

<p align="center">
  <img src="docs/home.png" alt="LeggiMi home screen" width="280" />
</p>

## Features

- **Reads many formats** — PDF, DOCX (Word), RTF, TXT, Markdown and other plain‑text files.
- **Share from any app** — send a file to LeggiMi from another app and it opens and starts reading automatically.
- **Sentence karaoke** — the sentence being spoken is highlighted and the view auto‑scrolls to follow along; tap any sentence to start reading from there.
- **Comfortable reader** — light / dark / sepia themes and an adjustable text size.
- **Playback controls** — play / pause, previous / next sentence, and a one‑tap speed control (0.75×–2.0×).
- **Resume where you left off** — reading position is saved per document.
- **Chapter / section index** — auto‑detected headings (or evenly split parts) in a slide‑up table of contents.
- **Pick your voice** — choose among the Italian TTS voices installed on the phone, preview them with one tap, or install more.
- **Works offline** — text extraction (including PDF) runs entirely on the device; no network required.

## How it works

- **PDF** — text is extracted on‑device by [pdf.js](https://mozilla.github.io/pdf.js/) running in a hidden, offline WebView (the library ships in `android/app/src/main/assets/pdfjs/`).
- **DOCX** — the `.docx` archive is unzipped with [JSZip](https://stuk.github.io/jszip/) and text is pulled from `word/document.xml`.
- **RTF / TXT / Markdown** — read directly, with light cleanup (de‑hyphenation, removing repeated headers/footers and page numbers).
- **Speech** — the extracted text is split into sentences and spoken with the device's TTS engine via [react-native-tts](https://github.com/ak1394/react-native-tts). The default reading language is Italian (`it-IT`).
- **Sharing** — incoming files are received with [react-native-receive-sharing-intent](https://github.com/Sairyss/react-native-receive-sharing-intent); the activity uses `singleTask` + `onNewIntent` so shares are caught whether the app is closed or already open.

## Getting started

### Prerequisites
- Node.js ≥ 20
- JDK 17+
- Android SDK (and an Android device or emulator). Set up your environment per the [React Native docs](https://reactnative.dev/docs/set-up-your-environment).

### Install dependencies
```sh
npm install
```

### Run (debug)
```sh
# start the Metro bundler
npm start

# in another terminal, build & launch on a connected device/emulator
npm run android
# with multiple devices: npx react-native run-android --deviceId <id>
```

### Build a release APK
The `release` build type is signed with the bundled debug keystore, so it produces a self‑contained, installable APK out of the box.
```sh
cd android
./gradlew assembleRelease          # Windows: .\gradlew.bat assembleRelease
# install on a specific device
adb -s <deviceId> install -r app/build/outputs/apk/release/app-release.apk
```
The output APK is at `android/app/build/outputs/apk/release/app-release.apk`.

> Tip: in Android Studio you can simply open the `android/` folder and press **Run** to build and deploy to your device.

## Using the app

1. Tap the folder icon (top‑left) to open a document, or **Share** a file to LeggiMi from any other app.
2. Press **▶** to start; tap any sentence to jump there.
3. Tap **Aa** (top‑right) for theme, text size, reading speed and **voice**.
4. The **☰** icon opens the chapter/section index when available.

### Voices
LeggiMi reads in Italian by default. To choose or add a voice: **Aa → Voce**. Tap a voice to hear a short preview; your choice is saved automatically. Use **“+ Installa altre voci…”** to download additional / higher‑quality voices from Android's text‑to‑speech settings. If no Italian voice is installed, install one there first.

## Tech stack

React Native 0.83 (New Architecture / Fabric, Hermes) · react-native-tts · pdf.js · JSZip · react-native-receive-sharing-intent · react-native-webview · AsyncStorage · react-native-safe-area-context.

## Project structure

```
App.tsx                         # the entire app (UI, extraction, TTS, sharing)
index.js                        # entry point
android/                        # native Android project
  app/src/main/assets/pdfjs/    # offline pdf.js for PDF text extraction
  app/src/main/java/.../MainActivity.kt
```

## Notes
- Scanned/image‑only PDFs have no embedded text, so they can't be read without OCR (not included).
- The app requests no storage permission; shared files are copied into the app cache before reading.
