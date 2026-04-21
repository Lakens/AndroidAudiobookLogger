# AndroidAudiobookLogger

A React Native Android app for playing audiobooks and marking timestamps directly into an [Obsidian](https://obsidian.md/) vault. Press a single button (or triple-tap your headphone centre button, or tap ⏮ on the lock screen) and the current playback position is written to a JSON log file inside your vault. A Python script then processes those timestamps into Obsidian notes.

---

## Table of Contents

1. [What the app does](#what-the-app-does)
2. [Architecture overview](#architecture-overview)
3. [Prerequisites](#prerequisites)
4. [Putting your phone in developer mode](#putting-your-phone-in-developer-mode)
5. [Enabling USB debugging and file transfer](#enabling-usb-debugging-and-file-transfer)
6. [Setting up the development environment](#setting-up-the-development-environment)
7. [Building and installing the app](#building-and-installing-the-app)
8. [Running Metro (JS bundler)](#running-metro-js-bundler)
9. [Granting storage permissions on the phone](#granting-storage-permissions-on-the-phone)
10. [Using the app](#using-the-app)
11. [Lessons learned](#lessons-learned)
12. [FAQ](#faq)

---

## What the app does

| Screen | Function |
|--------|----------|
| **Player** | Plays a single audio file. Tap **Open file** to pick any audio file from your phone. Controls: play/pause, 30-second jump forward/back, seek slider, playback speed (0.5x-2x), and **Mark Timestamp**. |
| **Library** | Scans a folder you configure and lists every audiobook with its last-played position and completion percentage. Tap any title to resume from where you left off. Pull to refresh. |
| **Settings** | Configure the audio folder path and the path to `timestamp_log.json` inside your Obsidian vault. Tap **Test** on either to verify the path exists. |

### Timestamp marking — three ways

1. **Tap Mark Timestamp** in the player (foreground).
2. **Tap the Previous button** on the lock-screen media notification or Android media controls widget.
3. **Triple-press the centre button** on your headphones. Android routes a triple centre-button press to "previous track", which the app intercepts to mark a timestamp instead.

Every timestamp is written as a JSON entry to `timestamp_log.json`:

```json
{"note": "My Audiobook Title", "timestamp": "1h 23m 45s", "positionSeconds": 5025, "date": "2026-04-20T21:00:00.000Z"}
```

The `note` field is derived from the audio filename with the extension stripped, so the MP3/M4A filename must match the Obsidian note stem exactly (e.g. `My Audiobook Title.mp3` maps to note `My Audiobook Title`).

---

## Architecture overview

```
index.js
 ├─ App.tsx                        React Navigation stack (Player / Library / Settings)
 ├─ src/screens/PlayerScreen.tsx   Main playback UI
 ├─ src/screens/LibraryScreen.tsx  Folder-scanning book list
 ├─ src/screens/SettingsScreen.tsx Storage permissions + path configuration
 ├─ src/services/AudioService.ts   Headless background service (lock-screen controls)
 ├─ src/utils/timestampManager.ts  Write/read timestamp_log.json
 ├─ src/utils/libraryManager.ts    Scan folder, persist last-played positions
 └─ src/utils/formatTime.ts        h:mm:ss formatter
```

**Native layer:**
`react-native-track-player 4.1.2` wraps ExoPlayer via a Kotlin `MusicService`. This library required significant patching to work with React Native 0.83 New Architecture — see [Lessons learned](#lessons-learned).

**Storage:**
- `@react-native-async-storage/async-storage 1.23.1` — persists folder path, log path, per-book positions
- `react-native-fs` — reads the audio folder and writes/reads `timestamp_log.json`
- `@react-native-documents/picker` — system file picker (no storage permission needed)

**Permissions:**
- `READ_MEDIA_AUDIO` (Android 13+) — to scan the configured audio folder
- `MANAGE_EXTERNAL_STORAGE` (Android 11-12) — same purpose on older Android
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` — background audio
- `WAKE_LOCK` — keep CPU awake during playback

---

## Prerequisites

Install these on your Windows PC before building:

| Tool | Version used | Notes |
|------|-------------|-------|
| [Node.js](https://nodejs.org/) | 18 LTS or newer | |
| [Android Studio](https://developer.android.com/studio) | Latest | Only needed for SDK tools |
| Android SDK Platform | 36 | via SDK Manager in Android Studio |
| Android NDK | 27.1.12297006 | SDK Manager → SDK Tools → NDK (Side by side) |
| Android Build Tools | 35.0.0 | via SDK Manager |
| Java (JDK) | 17 | Bundled with Android Studio |
| [Git](https://git-scm.com/) | Any | |

After installing Android Studio, set these environment variables (add to your PowerShell profile or system environment):

```powershell
$env:ANDROID_HOME = "C:\Users\<you>\AppData\Local\Android\Sdk"
$env:PATH += ";$env:ANDROID_HOME\platform-tools"
$env:PATH += ";$env:ANDROID_HOME\tools"
```

---

## Putting your phone in developer mode

Developer mode unlocks USB debugging and sideloading.

**Samsung Galaxy (tested device):**

1. Open **Settings**.
2. Go to **About phone**.
3. Tap **Software information**.
4. Find **Build number** and tap it **7 times** rapidly.
5. You will see a toast: *"You are now a developer!"*
6. Go back to **Settings** — a new **Developer options** entry appears near the bottom.

**Other Android phones:**
The Build number is usually at Settings → About phone → Build number (sometimes under a "Version" sub-menu).

---

## Enabling USB debugging and file transfer

1. Open **Settings → Developer options**.
2. Toggle **USB debugging** ON.
3. Connect your phone to the PC with a USB cable.
4. On the phone, a dialog appears: *"Allow USB debugging?"* — tap **Allow**. Check *Always allow from this computer* to avoid repeating this.
5. A second dialog asks about the USB connection mode — select **File Transfer (MTP)**.

Verify the connection in PowerShell:

```powershell
$env:PATH = "C:\Users\<you>\AppData\Local\Android\Sdk\platform-tools;" + $env:PATH
adb devices
```

You should see your phone with status `device`. If it shows `unauthorized`, check the USB debugging dialog on the phone again.

---

## Setting up the development environment

```powershell
git clone https://github.com/Lakens/AndroidAudiobookLogger.git
cd AndroidAudiobookLogger
npm install
```

> **Important:** `node_modules` contains files that have been **manually patched** for React Native 0.83 New Architecture compatibility. Do not delete `node_modules` and re-run `npm install` without re-applying the patches documented in [Lessons learned](#lessons-learned).

---

## Building and installing the app

All commands use **PowerShell**. Note: the `&&` operator does not work in Windows PowerShell 5.1 — use `;` to chain commands instead.

### 1. Set PATH for adb

```powershell
$env:PATH = "C:\Users\<you>\AppData\Local\Android\Sdk\platform-tools;" + $env:PATH
```

### 2. Build the release APK

```powershell
cd android
.\gradlew.bat assembleRelease --no-daemon
cd ..
```

The **first build takes 30-90 minutes** — it compiles the React Native C++ core (Hermes, Fabric, JSI) from source. Subsequent incremental builds take 20-60 seconds thanks to the Gradle configuration cache (enabled in `gradle.properties`).

The release build bundles the JavaScript inside the APK so the app works **without Metro running** — no USB needed after install.

> **Debug build** (only needed during development to see JS errors on screen):
> `.\gradlew.bat assembleDebug --no-daemon`
> APK: `android\app\build\outputs\apk\debug\app-debug.apk`

### 3. Install on the phone

```powershell
adb install -r android\app\build\outputs\apk\release\app-release-unsigned.apk
```

The `-r` flag reinstalls over an existing version without wiping data. The APK is unsigned, which is fine for personal use via `adb install`.

### 4. Port-forward Metro to the phone

```powershell
adb reverse tcp:8081 tcp:8081
```

Run this every time you reconnect the phone. This tunnels the phone's `localhost:8081` through USB to the PC, so the app can reach Metro.

### 5. Start Metro

Open a **separate PowerShell window** and run:

```powershell
cd C:\path\to\AndroidAudiobookLogger
npx react-native start --port 8081
```

Leave this window open while developing. The app loads its JavaScript from Metro. Without Metro running you will see a red error screen on the phone.

### 6. Launch the app

Tap the **AudiobookNotetaker** icon on the phone. The JS bundle downloads from Metro and the app appears.

---

## Running Metro (JS bundler)

For **JS-only changes** (anything in `src/`), you do not need to rebuild the APK. Save your file, then either:
- Press `r` in the Metro terminal window, or
- Shake the phone to open the React Native dev menu, then tap **Reload**.

Rebuild the APK only when you change:
- Native Android files (`.kt`, `.java` in `android/`)
- `AndroidManifest.xml`
- Native source inside `node_modules`

---

## Granting storage permissions on the phone

Open the app and navigate to the **Settings** tab.

- **Android 13+:** A red banner appears. Tap it — the system shows a standard permission dialog. Tap **Allow**.
- **Android 11-12:** Tap the banner — the app opens the *"All files access"* special settings page. Toggle it on.
- **Android 10 and below:** The system permission dialog appears automatically.

The Library tab needs this permission to scan your audio folder. The Player tab works without it because the file picker has its own access.

---

## Using the app

### First run

1. Go to **Settings**.
2. Set **Audio folder** to the full path of your audiobooks folder, for example:
   `/storage/emulated/0/OneDrive - TU Eindhoven/obsidian/pdf_audio_outputs`
3. Set **Timestamp log path** to the full path of `timestamp_log.json`, for example:
   `/storage/emulated/0/OneDrive - TU Eindhoven/obsidian/99 - System/timestamp_log.json`
4. Tap **Save** on both, then tap **Test** to verify the paths resolve.
5. Go to the **Library** tab and pull down to scan.
6. Tap any title to start playing.

### Playing a file not in the library

In the **Player** tab, tap **Open file** to use the system file picker.

### Marking a timestamp

While listening, use any of:
- Tap **Mark Timestamp** on screen.
- Press the **Previous** button on the lock-screen notification.
- Triple-press the **centre button** on wired or Bluetooth headphones.

---

## Lessons learned

This section documents every non-obvious technical problem encountered during development. Read this carefully before updating any dependency.

### 1. React Native 0.82+ forces New Architecture — you cannot opt out

`newArchEnabled=false` in `gradle.properties` is silently ignored from RN 0.82 onward. New Architecture (Fabric + TurboModules) is always on. Any library not updated for New Architecture must be patched.

### 2. react-native-track-player 4.1.2 requires three separate patches

**Patch A — @ReactMethod return types must be Unit**

`TurboModuleInteropUtils` requires every `@ReactMethod` to return void (Unit). The original code used Kotlin expression syntax which returns `Job`:

```kotlin
// WRONG — returns Job (non-void), crashes TurboModule interop
@ReactMethod
fun pause(callback: Promise) = scope.launch { ... }
```

Fix: use statement body instead:

```kotlin
// CORRECT — returns Unit
@ReactMethod
fun pause(callback: Promise) { scope.launch { ... } }
```

This affected 36 methods in `MusicModule.kt`. The one that was hardest to spot used `=\n    scope.launch {` across two lines (the `updateMetadataForTrack` method).

**Patch B — MusicService.emit() uses reactNativeHost which throws in New Architecture**

`MusicService` emits playback events to JavaScript via `reactNativeHost.reactInstanceManager.currentReactContext`. In RN 0.83, calling `getReactNativeHost()` on a New Architecture app throws:

```
RuntimeException: You should not use ReactNativeHost directly in the New Architecture
```

Fix: add a helper that catches this and falls back to `reactHost`:

```kotlin
private fun resolveReactContext(): ReactContext? {
    return try {
        @Suppress("DEPRECATION")
        reactNativeHost.reactInstanceManager.currentReactContext
    } catch (_: Exception) {
        (application as? ReactApplication)?.reactHost?.currentReactContext
    }
}
```

Note: the method cannot be named `getReactContext()` because `MusicService` already has a `reactContext` property — the JVM signature would clash.

**Patch C — ForegroundServiceStartNotAllowedException on Android 12+**

After a crash, Android may restart `MusicService` in a background context. `startForeground()` then throws `ForegroundServiceStartNotAllowedException`. Additionally, `START_STICKY` caused Android to keep trying to restart the service without the app being in the foreground, creating a crash loop.

Fix: wrap `startForeground` in try-catch, stop the service gracefully if it fails, and return `START_NOT_STICKY`.

### 3. registerPlaybackService needs .default for ES module exports

```js
// WRONG — require() returns { default: fn } for ES module default exports
TrackPlayer.registerPlaybackService(() => require('./src/services/AudioService'));

// CORRECT
TrackPlayer.registerPlaybackService(() => require('./src/services/AudioService').default);
```

Without `.default`, TrackPlayer receives an object instead of a function and crashes with:
`TypeError: taskProvider() is not a function (it is Object)`

### 4. AudioService runs before setupPlayer resolves — race condition

When `setupPlayer()` is called from JS:
1. The native side starts `MusicService`.
2. `MusicService.onStartCommand` immediately fires the HeadlessJS background task, which runs `AudioService.ts`.
3. `AudioService.ts` calls `TrackPlayer.updateOptions()` — but the player is not yet initialized (the promise resolves later in `onServiceConnected`).

Fix: wrap `updateOptions` in `AudioService.ts` in try-catch, and also call `updateOptions` from `PlayerScreen.tsx` inside the `.then()` of `setupPlayer` as a guaranteed fallback.

### 5. Working toolchain versions

| Component | Version |
|-----------|---------|
| React Native | 0.83.0 |
| Gradle | 9.0.0 |
| Android Gradle Plugin | 8.7.2 |
| Kotlin | 2.1.20 |
| NDK | 27.1.12297006 |
| async-storage | 1.23.1 (NOT 2.x — KMP artifact fails to resolve) |
| document picker | @react-native-documents/picker (replaces deprecated react-native-document-picker v9+) |

### 6. PowerShell 5.1 does not support &&

Windows ships with PowerShell 5.1 which does not support the `&&` pipeline chain operator (available in PowerShell 7+). Use `;` to chain unconditionally, or `; if ($?) { <next command> }` to chain conditionally.

### 7. adb reverse is required for Metro on a physical device

A physical phone cannot reach `localhost` on the PC. After every USB reconnect, run:

```powershell
adb reverse tcp:8081 tcp:8081
```

This tells the phone to forward its `localhost:8081` through the USB cable to the PC.

### 8. adb is not on PATH by default in PowerShell

Set it manually at the start of any build session:

```powershell
$env:PATH = "C:\Users\<you>\AppData\Local\Android\Sdk\platform-tools;" + $env:PATH
```

### 9. The first build takes up to 90 minutes

React Native 0.83 compiles native C++ code (Hermes VM, Fabric renderer, JSI) from source on the first build. This is normal. Do not interrupt it. All subsequent incremental builds are fast.

### 10. react-native-document-picker v9 removed GuardedResultAsyncTask

The old `react-native-document-picker` package broke in RN 0.73+ because `GuardedResultAsyncTask` was removed from React Native. The replacement package is `@react-native-documents/picker` with a different API:

```typescript
// Old (broken in RN 0.73+)
const result = await DocumentPicker.pick({ type: [DocumentPicker.types.audio] });

// New
import { pick, types } from '@react-native-documents/picker';
const [result] = await pick({ type: [types.audio] });
```

---

## FAQ

**Q: The app crashes immediately when I try to open or play a file.**
A: Most likely Metro is not running. Start Metro with `npx react-native start --port 8081` and run `adb reverse tcp:8081 tcp:8081`. Also make sure the phone screen is unlocked when you first open the app.

**Q: I see a red "Unable to load script" screen.**
A: Metro is not reachable. Check: (1) Metro terminal is open and shows "Metro waiting on port 8081", (2) you have run `adb reverse tcp:8081 tcp:8081`, (3) the phone is connected (`adb devices` shows it).

**Q: The app crashes with ForegroundServiceStartNotAllowedException.**
A: This occurs on Android 12+ when the service restarts in background context after a crash. It is fixed by the `START_NOT_STICKY` patch in `MusicService.kt`. If it reappears, force-stop the app from Android Settings and relaunch.

**Q: The app crashes with "You should not use ReactNativeHost in the New Architecture".**
A: This is the `MusicService.emit()` bug. It is fixed in the patched `MusicService.kt`. If it reappears after running `npm install`, re-apply Patch B from the lessons above.

**Q: I get "TypeError: taskProvider() is not a function" in logcat.**
A: `index.js` is missing `.default`. Ensure it reads:
`TrackPlayer.registerPlaybackService(() => require('./src/services/AudioService').default);`

**Q: adb is not recognized as a command.**
A: Run `$env:PATH = "C:\Users\<you>\AppData\Local\Android\Sdk\platform-tools;" + $env:PATH` in PowerShell.

**Q: The build fails with a Gradle download timeout.**
A: Check `android/gradle/wrapper/gradle-wrapper.properties` — the `distributionUrl` must point to a Gradle version you have cached at `%USERPROFILE%\.gradle\wrapper\dists\`. Gradle 9.0.0 is the tested version.

**Q: newArchEnabled=false in gradle.properties has no effect.**
A: Correct. React Native 0.82+ ignores this flag. New Architecture is mandatory.

**Q: How do I find my phone's full storage path for the audio folder?**
A: Open a file manager on the phone, navigate to your folder, and use Properties or Share to see the full path. On Samsung with OneDrive, it is typically:
`/storage/emulated/0/OneDrive - TU Eindhoven/obsidian/pdf_audio_outputs`

**Q: The Library tab shows no files.**
A: (1) Check the storage permission banner in Settings. (2) Tap Test next to the folder path. (3) Pull to refresh in the Library tab.

**Q: Changes to JS files do not appear on the phone.**
A: Shake the phone to open the dev menu and tap Reload, or press `r` in the Metro terminal.

**Q: Do I need Android Studio open while building?**
A: No. The build uses `gradlew.bat` from the command line. Android Studio is only needed initially to install the Android SDK, NDK, and Build Tools via its SDK Manager.

**Q: Which files in node_modules were patched?**
A: The following files differ from the published npm package:
- `node_modules/react-native-track-player/android/.../MusicModule.kt` — 36 @ReactMethod return-type fixes + null safety for Bundle
- `node_modules/react-native-track-player/android/.../MusicService.kt` — resolveReactContext() helper, startForeground try-catch, START_NOT_STICKY
- `node_modules/@react-native/gradle-plugin/...` — Kotlin 2.1.20 and AGP 8.7.2 version bumps, apiVersion "2.0"
