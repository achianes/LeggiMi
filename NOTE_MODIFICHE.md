# Note sulle modifiche — LeggiMi "locale" (29/09/2026)

Obiettivo: app **generica e pubblicabile sul Play Store**, tutta sul telefono, **senza login Google
e senza il progetto Google dello sviluppatore**.

LeggiMi era già locale (niente server, niente account). L'unico legame era il **cloud**: il salvataggio
dei documenti su Google Drive passava da un login OAuth che funziona solo con il progetto Google
dello sviluppatore (`leggimi-509009`) e con l'impronta della chiave di firma registrata lì.

## Cosa è cambiato

### 1. Documenti su Google Drive senza login: «Salva in…»
- Nuova funzione `saveElsewhere()` in `App.tsx`: usa `saveDocuments()` di
  `@react-native-documents/picker` (già presente), cioè la **finestra di sistema "Salva in"**.
  L'utente sceglie Google Drive, un altro cloud o una cartella: è Android a parlare con Drive.
  Nessun account, chiave o progetto Google nell'app.
- Sostituisce ogni caricamento sul cloud:
  - dopo un'esportazione (PDF/TXT, trascrizioni, audiolibro): la scelta "Cloud" diventa **"Salva in…"**;
  - Libreria ☁️ "Sposta": salva il PDF dove scegli e **solo se il salvataggio riesce** toglie il documento dal telefono;
  - Scanner (`src/scan/ScanStudio.tsx`): il tasto "CLOUD" diventa **"SALVA IN…"**.
- Tolti: il pannello "Account cloud" (`CloudSheet`), la voce "Cloud drives" nelle Impostazioni,
  l'icona ☁️ in testa alla Libreria e la proposta automatica "Tienilo nel tuo cloud?".
- **Sincronizzazione della posizione di lettura** tra dispositivi: spenta
  (`src/cloud/sync.ts`: `CLOUD_ACCOUNTS = false` → nessun account → la sync non parte), tolto l'interruttore.
- Il codice cloud (`src/cloud/*`, `LeggiMiCloudModule.kt`, WebDAV/Dropbox) **resta nel progetto ma non è usato**:
  si può riaccendere cambiando `CLOUD_ACCOUNTS` (servirebbe di nuovo il progetto Google) o rimuovere
  del tutto più avanti (vedi "Da fare").
- Nuove frasi tradotte in **it / es / fr / de** (`src/i18n/*.json`, solo aggiunte).

### 2. Backup del telefono (prima era disattivato)
- `AndroidManifest.xml`: `allowBackup="true"` + `res/xml/backup_rules.xml` e `data_extraction_rules.xml` (nuovi).
- Backup Google (cloud): **impostazioni, posizioni di lettura ed elenco della Libreria** (database AsyncStorage).
  Testi dei documenti, scansioni e modelli scaricati restano fuori: il limite di 25 MB farebbe saltare tutto.
- Passaggio diretto telefono→telefono: anche testi (`library/`), scansioni (`scans/`) e cache auto (`auto/`).
- Voci, modelli AI e di trascrizione si riscaricano quando servono.
- I segreti cloud (`SecretStore`) non vanno nel backup.

### 3. Firma release
- Nuovo keystore `android/keystore/leggimi-release.jks` + `android/signing.properties`,
  **entrambi fuori da git** (`.gitignore`). Prima la release era firmata con `debug.keystore` (lo Store la rifiuta).
- Senza `signing.properties` la release si firma con la chiave debug (solo per prove).
- ⚠️ **Conservare keystore e password**: senza, non si pubblicano aggiornamenti.
- ⚠️ Le installazioni esistenti (chiave debug) non si aggiornano con la release nuova: serve disinstallare
  (si perdono libreria e voci scaricate sul telefono).

## Provato (BlueStacks, APK con chiave debug per non perdere i dati)
- Libreria: nuova frase tradotta (tedesco), niente icona cloud in testa.
- Esporta → File di testo → "Speichern in…" → finestra di sistema → salvato in Download (86 KB, nome con spazi ok).
- TypeScript: 0 errori (come prima). Release firmata con la chiave nuova: ok.

## Da fare / attenzione
- Rimuovere del tutto il cloud per un APK più pulito: `LeggiMiCloudModule` (registrato in
  `scan/LeggiMiScanPackage.kt`), `src/cloud/CloudSheet.tsx`, dipendenze `play-services-auth` e `okhttp`.
- `react-native-google-cast` e `react-native-youtube-iframe` non sono usati ma sono nelle dipendenze
  (e il manifest registra `GoogleCastOptionsProvider`): da togliere prima dello Store.
- Una copia completa a mano (zip con libreria + impostazioni, "Salva copia / Ripristina") come in
  RoadNavigator e Pay & Plan non c'è ancora.
- Il README cita PayPal, Pay & Plan e i passi per il progetto Google: da ripulire per lo Store.
- Alcune frasi esistenti non sono tradotte (es. "Send it somewhere else too?"): non toccate.
