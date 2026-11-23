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

| App → page (injected) | |
|---|---|
| `window.__sbFace(sample)` | one frame's `FaceSample` |
| `window.__sbCam('denied' \| 'error' \| 'off', detail?)` | the camera's state |

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
