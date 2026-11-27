# Vidrip Party (app)

Vidrip Party as an iOS and Android app. The game itself is the web build at
https://vidrip.app/party (code in `dev/vidrip-party`). This app shows it full screen in a WebView and does the one
thing a web view does badly on phones: the camera and face tracking, natively.

## How it works

- `App.tsx` loads `https://vidrip.app/party/?app=1` in a WebView. Web deploys reach the app right away; app
  updates are only needed for native changes.
- When the game turns the face controller on, the app opens the front camera and runs the Mimic landmarker natively
  (`@vidrip/mimic-react-native`, the same SDK as the Bro games). Each frame's numbers (head pose and the 52
  expression scores, about 1 KB) are injected into the page as `window.__sbFace(sample)`.
- In the page, `src/nativeMimic.ts` feeds those samples to the same `MimicEngine` the web build uses, so
  gestures, calibration and tuning match the web exactly. It is used whenever `window.ReactNativeWebView` exists.
- The camera picture is a native view laid over the page where the game's `#cam` element is (the setup circle, the
  HUD bubble). The page reports that box with `{ t: 'camLayout', … }` whenever it moves.

### Messages

| Page → app (`ReactNativeWebView.postMessage`) | |
|---|---|
| `{ t: 'camStart' }` / `{ t: 'camStop' }` | face tracker on / off |
| `{ t: 'camLayout', visible, x, y, w, h, radius, opacity, border, borderWidth }` | where to show the camera picture |
| `{ t: 'share', title, text, url }` | the phone's share sheet (invite and squad links) |
| `{ t: 'open', url }` | open a link in the browser |
| `{ t: 'pushAsk' }` | turn push on: OS permission prompt, then the FCM token comes back |
| `{ t: 'openStore', url }` | the force-update screen's button: open the store page (only `https`, `market`, `itms-apps` links) |

| App → page (injected) | |
|---|---|
| `window.__sbFace(sample)` | one frame's `FaceSample` |
| `window.__sbCam('denied' \| 'error' \| 'off', detail?)` | the camera's state |
| `window.__pushNative = true` | set before the page loads: push goes through FCM |
| `window.__appInfo = { platform, build, version }` | set before the page loads: the real native build (`versionCode` / `CFBundleVersion` as a number, `versionName` / `CFBundleShortVersionString`), read with `react-native-device-info` |
| `window.__sbPushToken(token, 'ios' \| 'android')` | the FCM token (after `pushAsk`, at launch if already allowed, on refresh) |
| `window.__sbPushState('granted' \| 'denied')` | the OS notification permission |
| `window.__sbPushOpen({ kind, lobby? })` | a notification was tapped (`friend`, `game`, `msg`, `story`, `admin`) |

The page may load before it defines the push hooks, so the latest values are also kept in `window.__pushLast`
(`{ token, platform, state }`) and a tap in `window.__pushOpenPending` (the page clears it once handled).
Foreground messages are ignored: the page already has a live connection.

### Force update

The page (`src/updater.ts` in `dev/vidrip-party`) reads `GET /config` on the rooms Worker (start, every 5 min, when the tab
becomes visible). If `window.__appInfo.build` is below `app.<platform>.min` and that platform's `url` is set, it shows a
blocking "A new version is ready" screen (only between rounds); its button posts `openStore`, and the app opens the URL.
The floor, store URLs and the web "force reload" are set from vidrip.app/ops/party (Updates card). A new native build
must raise its own build number (Android `versionCode`, iOS `CFBundleVersion`) for this to compare correctly.

Links that leave the game (Follow on Vidrip, policies) open in the browser. Vidrip sign-in stays inside the WebView;
it uses email codes and passwords, which work in web views.

## Ids

- Android `org.vidrip.party`, iOS `org.vidrip.party`, display name Vidrip Party.
- `patches/@vidrip+mimic-landmarker+0.5.0.patch` adds the `homepage` the landmarker's podspec needs (`npm install`
  applies it).

## Build

```
npm install                                   # needs the @vidrip GitHub Packages token in your user ~/.npmrc
cd android && ./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
```

iOS builds on CI (TestFlight), like the Bro games.

## Push notifications (setup, once)

The server sends through FCM (plan: `dev/vidrip-party/plan/push.md`); the app only hands the token to the page. The
builds work without the Firebase files below (push is simply off), so do these before the release that turns it on.

1. Firebase console: create a project (or reuse one). Add an **Android** app with package `org.vidrip.party` and an
   **iOS** app with bundle id `org.vidrip.party`.
2. Download the two files and put them here (they are not committed; add to `.gitignore` if not ignored):
   - `android/app/google-services.json`
   - `ios/VidripParty/GoogleService-Info.plist` (an Xcode build phase copies it into the app when present; on CI,
     write it into that path before the build, e.g. from a secret)
3. Apple Developer: Keys > create an **APNs auth key** (.p8, Apple Push Notifications service). In Firebase >
   Project settings > Cloud Messaging > Apple app configuration, upload it (with the Key ID and Team ID).
4. Firebase > Project settings > Service accounts > **Generate new private key** (JSON). Send it to the server:
   `cd dev/vidrip-party/server && wrangler secret put FCM_SERVICE_ACCOUNT` (paste the whole JSON). Delete the downloaded file.
5. Apple Developer: the App ID `org.vidrip.party` needs the **Push Notifications** capability (cloud signing on the
   CI usually enables it from the entitlement; if the build says the profile lacks `aps-environment`, tick it
   under Identifiers).
6. `npm install` (adds `@react-native-firebase/app` + `messaging`, updates the lockfile), then `cd ios && pod install`.
   Native rebuild needed on both platforms: a web deploy alone does not enable push in the app.

Native pieces added: Android `POST_NOTIFICATIONS`, the `default` notification channel (`MainApplication.kt`), the
google-services Gradle plugin (applied only if `google-services.json` exists); iOS `UIBackgroundModes:
remote-notification`, `VidripParty.entitlements` (`aps-environment` = development; automatic signing switches it to
production for store builds), `FirebaseApp.configure()` only if the plist is bundled.

Store notes: iOS App Privacy: Data Collected > Identifiers > Device ID (the push token), linked to the user, used for
App Functionality, not for tracking. Play Data safety: Device or other IDs (push token), collected, App
functionality. Say the notifications are friend requests, game invites, friend messages and the daily story reminder,
all optional and switchable in Settings. Test: a physical iPhone (simulators cannot get a real APNs token) and an
Android 13+ device, tap a notification with the app closed and check the page routes.
