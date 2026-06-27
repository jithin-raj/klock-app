# Klocky Mobile — Setup & Run

A React Native (bare CLI) shell that hosts the Angular web app in a WebView and adds FCM push,
a stable device id, the `isMobile` login header, and OS permissions for camera/location.

- **applicationId / Android package:** `com.klock.app`
- **Web app URL:** `https://klock.vercel.app` (set in [App.tsx](App.tsx) → `WEB_APP_URL`)
- **React Native:** 0.86, React 19

## What's already wired up

- [App.tsx](App.tsx) — WebView shell: injects `window.__IS_MOBILE__`, sends `klocky:device`
  (deviceId, platform, fcmToken), handles push tap → `klocky:navigate`, loading/error/retry UI,
  Android hardware back, runtime permission requests.
- [index.js](index.js) — FCM background message handler (system tray displays the notification).
- Android: `google-services` classpath + plugin, camera/location/notification permissions,
  `applicationId = com.klock.app`.
- iOS: `FirebaseApp.configure()` in AppDelegate, camera/location/mic usage strings,
  `remote-notification` background mode.

## ⚠️ Before you can build Android — add `google-services.json`

The Android build will **fail** until this file exists, because the `com.google.gms.google-services`
plugin reads it at build time.

1. In the [Firebase console](https://console.firebase.google.com/), open your project →
   **Add app → Android**.
2. Set the **Android package name** to exactly **`com.klock.app`** (must match `applicationId`).
3. Download the generated **`google-services.json`**.
4. Place it at:

   ```
   KlockyMobile/android/app/google-services.json
   ```

   (Same folder as `android/app/build.gradle`.)

That's it — no code change needed after dropping the file in.

### iOS (when building on a Mac)

1. Firebase console → **Add app → iOS**, bundle id = your iOS bundle identifier.
2. Download **`GoogleService-Info.plist`** and add it to the **KlockyMobile** target in Xcode
   (drag into the project, "Copy items if needed", target checked).
3. In Xcode → Signing & Capabilities, add **Push Notifications** and
   **Background Modes → Remote notifications**.
4. `cd ios && pod install && cd ..`

## Prerequisites to build

- Node 18+ (project scaffolded with Node 20; `package.json` engines suggests 22 but 20 works).
- **JDK 17** and **Android Studio** with the Android SDK (set `ANDROID_HOME`). Neither was on PATH
  in this environment — install before `run-android`.
- Xcode (iOS only, macOS only).

## Run

```bash
# from KlockyMobile/
npm start                 # Metro bundler (separate terminal)

npx react-native run-android   # needs google-services.json + Android SDK + JDK 17
npx react-native run-ios       # macOS only
```

Release builds: signed APK/AAB (Android), Xcode Archive (iOS). Ensure the Firebase Android/iOS apps
match the release `applicationId` / bundle id.

## Angular changes (in the existing web app — not in this repo)

See the snippets in [docs/angular-bridge.md](docs/angular-bridge.md): the `isMobile` HTTP
interceptor, `register-device` on login, and `/logout` on logout.

## Smoke test

1. Launch app → WebView loads `klock.vercel.app` with `window.__IS_MOBILE__ === true`.
2. Log in → backend returns a 30-day token (org must have mobile enabled).
3. `POST /api/mobile/register-device` returns 200.
4. Send a notification → device receives it (foreground via SignalR/`klocky:push`,
   background/terminated via FCM system notification; tapping deep-links via `data.route`).
