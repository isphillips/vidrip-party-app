// Vidrip Party, the app: the web game (vidrip.app/party) full screen in a WebView, with the camera and the face
// landmarker running natively (Mimic for React Native). Each camera frame's numbers (pose + blendshapes) go into the
// page, where the game's own Mimic engine reads them (vidrip-party/src/nativeMimic.ts). The camera's picture is a
// native view laid over the page wherever the game's #cam element is.
//
// Page → app (window.ReactNativeWebView.postMessage, JSON):
//   { t: 'camStart' } / { t: 'camStop' }                  the game wants the face tracker on / off
//   { t: 'camLayout', visible, x, y, w, h, radius, … }     where (and whether) to show the camera picture
//   { t: 'share', title, text, url }                        the phone's share sheet
//   { t: 'open', url }                                     a link in the browser
//   { t: 'clipChunk', … } / { t: 'clipDone', … }            a finished clip to save to Photos or share (src/clipBridge.ts)
//   { t: 'pushAsk' }                                        turn push on: ask the OS for notification permission, then send the FCM token
//   { t: 'openStore', url }                                 the force-update screen's button: open the store page (only https / market / itms-apps links)
// App → page (injected JavaScript):
//   window.__sbFace(sample)                                 one frame's FaceSample
//   window.__sbCam('denied' | 'error' | 'off', detail?)    the camera's state
//   window.__clipResult({ id, ok, error? })                 how a clip Save / Share went
//   window.__appInfo = { platform, build, version }         set before the page loads: the real native build (Android versionCode / iOS CFBundleVersion as a number, versionName / CFBundleShortVersionString); the page compares it to the remote floor (GET /config)
//   window.__pushNative = true                              set before the page loads: this is the app, push goes through FCM (kind 'fcm')
//   window.__sbPushToken(token, 'ios' | 'android')          the device's FCM token (after pushAsk, on launch if already allowed, on refresh)
//   window.__sbPushState('granted' | 'denied')              the OS notification permission (after pushAsk, and on launch)
//   window.__sbPushOpen({ kind, lobby? })                   a notification was tapped (kind: friend | game | msg | story | admin)
//   (The page may have loaded before it defined these hooks, so the latest values also sit in window.__pushLast =
//   { token, platform, state } and window.__pushOpenPending = { kind, lobby? } (cleared by the page once handled).)
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, BackHandler, Image, Linking, PermissionsAndroid, Platform, Share, StatusBar, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation, type WebViewProps } from 'react-native-webview';
import { NativePreviewView, useCamera, useCameraDevice, useCameraPermission, usePreviewOutput } from 'react-native-vision-camera';
import { useMimic } from '@vidrip/mimic-react-native';
import type { FaceSample } from '@vidrip/mimic-core';
import { SPARSE_INDICES } from '@vidrip/mimic-landmarker';
import { AuthorizationStatus, getInitialNotification, getMessaging, getToken, hasPermission, onNotificationOpenedApp, onTokenRefresh, requestPermission as requestPushPermission, type FirebaseMessagingTypes } from '@react-native-firebase/messaging';
import DeviceInfo from 'react-native-device-info';
import { onClipMessage, type ClipMsg } from './src/clipBridge';

/** The game. (`app=1` tells the page it is inside the app.) */
const GAME_URL = 'https://vidrip.app/party/?app=1';
/** The native build, for the page's force-update check (window.__appInfo). build = versionCode (Android) / CFBundleVersion (iOS). */
const APP_INFO = JSON.stringify({ platform: Platform.OS === 'ios' ? 'ios' : 'android', build: Number.parseInt(DeviceInfo.getBuildNumber(), 10) || 0, version: DeviceInfo.getVersion() });
/** Store links the page may ask to open (the update button). */
const STORE_URL = /^(https:\/\/|market:\/\/|itms-apps:\/\/)\S+$/;
/** Pages the WebView may open itself: the game and all of vidrip.app (sign-in goes through /oauth, /connect, …),
 *  except creator profiles and channels (Follow on Vidrip), which open in the browser like every other site. */
const INSIDE = /^https:\/\/(www\.)?vidrip\.app\/(?!creators\/|c\/)|^https:\/\/([a-z0-9-]+\.)?vidrip-party\.pages\.dev|^about:blank/;

// (react-native-webview 14's class typings resolve to `never` props under React 19 + TS 6: the same component, typed plainly.)
const Web = WebView as unknown as React.ComponentType<WebViewProps & { ref?: React.Ref<WebView> }>;

/** Push: the OS notification permission. Android below 13 has none to ask (granted). */
async function pushGranted(ask: boolean): Promise<boolean> {
  if (Platform.OS === 'android') {
    if (Number(Platform.Version) < 33) { return true; }
    const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (await PermissionsAndroid.check(perm)) { return true; }
    return ask && (await PermissionsAndroid.request(perm)) === PermissionsAndroid.RESULTS.GRANTED;
  }
  const m = getMessaging();
  let s = await hasPermission(m);
  if (s === AuthorizationStatus.NOT_DETERMINED && ask) { s = await requestPushPermission(m); }
  return s === AuthorizationStatus.AUTHORIZED || s === AuthorizationStatus.PROVISIONAL;
}

/** Push: a tapped notification's data as the page wants it. */
function pushOpenOf(m: FirebaseMessagingTypes.RemoteMessage | null): { kind: string; lobby?: string } | null {
  const d = m?.data as { kind?: string; lobby?: string } | undefined;
  if (!d || typeof d.kind !== 'string') { return null; }
  return typeof d.lobby === 'string' ? { kind: d.kind, lobby: d.lobby } : { kind: d.kind };
}

type CamLayout = { visible: boolean; x: number; y: number; w: number; h: number; radius: number; opacity: number; border?: string; borderWidth?: number };

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <Game />
    </SafeAreaProvider>
  );
}

function Game() {
  const web = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  const { hasPermission, requestPermission } = useCameraPermission();
  const [camOn, setCamOn] = useState(false);
  const [layout, setLayout] = useState<CamLayout | null>(null);
  // (At launch Android can still report 'unknown' here, and no 'change' follows until the app is backgrounded once:
  // counting that as "not active" kept the camera off for anyone who'd already granted it. Only a real background /
  // inactive state pauses it.)
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [loaded, setLoaded] = useState(false);
  const canGoBack = useRef(false);
  const aliveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inject = useCallback((js: string) => { web.current?.injectJavaScript(`${js};true;`); }, []);

  // Push. Hands the page the OS permission and the FCM token (ask = show the OS prompt, only after the page's pushAsk).
  // Never throws: without the Firebase config files the token call fails and push stays off.
  const pushPlatform = Platform.OS === 'ios' ? 'ios' : 'android';
  const pushSync = useCallback(async (ask: boolean) => {
    try {
      const ok = await pushGranted(ask);
      if (!ok) {
        // (Before the first ask, "not yet asked" is not "denied": say nothing and let the page offer its button.)
        if (ask) { inject(`window.__pushLast=Object.assign(window.__pushLast||{},{state:'denied'});window.__sbPushState&&window.__sbPushState('denied')`); }
        return;
      }
      const token = await getToken(getMessaging());
      const arg = JSON.stringify(token), plat = JSON.stringify(pushPlatform);
      inject(`window.__pushLast={token:${arg},platform:${plat},state:'granted'};window.__sbPushState&&window.__sbPushState('granted');window.__sbPushToken&&window.__sbPushToken(${arg},${plat})`);
    } catch { /* Firebase not configured in this build */ }
  }, [inject, pushPlatform]);
  const pushOpen = useRef<{ kind: string; lobby?: string } | null>(null);
  const pushOpenSend = useCallback(() => {
    const o = pushOpen.current;
    if (!o) { return; }
    pushOpen.current = null;
    const arg = JSON.stringify(o);
    inject(`window.__pushOpenPending=${arg};window.__sbPushOpen&&window.__sbPushOpen(${arg})`);
  }, [inject]);
  useEffect(() => {
    let off: Array<() => void> = [];
    try {
      const m = getMessaging();
      // A tap while the app runs in the background, or the tap that launched it. (Foreground messages are ignored:
      // the page has a live connection and shows its own alerts.)
      off.push(onNotificationOpenedApp(m, (msg) => { pushOpen.current = pushOpenOf(msg); pushOpenSend(); }));
      getInitialNotification(m).then((msg) => { const o = pushOpenOf(msg); if (o) { pushOpen.current = o; } }).catch(() => {});
      off.push(onTokenRefresh(m, () => { pushSync(false); }));
    } catch { off = []; /* Firebase not configured in this build */ }
    return () => off.forEach((f) => f());
  }, [pushSync, pushOpenSend]);

  // The page's safe-area insets (Android web views don't fill env(safe-area-inset-*) themselves).
  const insetJs = `document.documentElement.style.setProperty('--safe-t','${insets.top}px');document.documentElement.style.setProperty('--safe-b','${insets.bottom}px');`;
  // The app flags (push goes through FCM; the app's build for the update gate). Set BEFORE the page loads where Android's document-start hook works, and AGAIN right after every load: the page reads them when it needs them, so either route is enough (build 4 showed the document-start route is not reliable on every Android web view).
  const flagsJs = `window.__pushNative=true;window.__appInfo=${APP_INFO};`;
  useEffect(() => { inject(flagsJs + insetJs); }, [inject, flagsJs, insetJs]);

  useEffect(() => {
    // The page hears it too (window.__sbApp): it silences its sound while the app is in the background, which an
    // Android web view never tells it on its own.
    const sub = AppState.addEventListener('change', (s) => {
      setForeground(s === 'active'); inject(`window.__sbApp&&window.__sbApp(${JSON.stringify(s)})`);
      // Back from the background: iOS may have killed the web view's process (a black or blank screen, no page left to answer). Ask the page; no answer in 2.5 s = reload it.
      if (s === 'active') {
        if (aliveTimer.current) { clearTimeout(aliveTimer.current); }
        aliveTimer.current = setTimeout(() => { aliveTimer.current = null; web.current?.reload(); }, 2500);
        inject(`window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({t:'alive'}))`);
      }
    });
    return () => sub.remove();
  }, [inject]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack.current) { web.current?.goBack(); return true; }
      return false;
    });
    return () => sub.remove();
  }, []);

  const onMessage = useCallback(async (e: WebViewMessageEvent) => {
    let msg: { t?: string } & Partial<CamLayout> & { url?: string };
    try { msg = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (msg.t === 'alive') {
      if (aliveTimer.current) { clearTimeout(aliveTimer.current); aliveTimer.current = null; }
    } else if (msg.t === 'camStart') {
      const ok = hasPermission || (await requestPermission());
      if (!ok) { inject(`window.__sbCam&&window.__sbCam('denied')`); return; }
      setCamOn(true);
    } else if (msg.t === 'camStop') {
      setCamOn(false);
      inject(`window.__sbCam&&window.__sbCam('off')`);
    } else if (msg.t === 'camLayout') {
      setLayout(msg as CamLayout);
    } else if (msg.t === 'share') {
      // The game's invite / squad links: the phone's share sheet.
      const m = msg as { text?: string; url?: string; title?: string };
      Share.share({ message: [m.text, m.url].filter(Boolean).join(' '), url: m.url, title: m.title }).catch(() => {});
    } else if (msg.t === 'open' && typeof msg.url === 'string') {
      Linking.openURL(msg.url).catch(() => {});
    } else if (msg.t === 'openStore' && typeof msg.url === 'string' && STORE_URL.test(msg.url)) {
      Linking.openURL(msg.url).catch(() => {});
    } else if (msg.t === 'pushAsk') {
      await pushSync(true);
    } else if (msg.t === 'clipChunk' || msg.t === 'clipDone') {
      // The "Your best face" clip, in chunks: save it to Photos or open the share sheet on it.
      const r = await onClipMessage(msg as ClipMsg);
      if (r) { inject(`window.__clipResult&&window.__clipResult(${JSON.stringify(r)})`); }
    }
  }, [hasPermission, requestPermission, inject, pushSync]);

  // Links out of the game (Follow on Vidrip, the privacy page …) open in the browser.
  const onNavigate = useCallback((req: WebViewNavigation) => {
    if (INSIDE.test(req.url)) { return true; }
    Linking.openURL(req.url).catch(() => {});
    return false;
  }, []);

  return (
    <View style={styles.root}>
      <Web
        ref={web}
        source={{ uri: GAME_URL }}
        style={styles.web}
        originWhitelist={['https://*']}
        onMessage={onMessage}
        // The OS killed the web view's process (iOS does this to a backgrounded app, or under memory pressure): load the game again instead of leaving a black screen.
        onContentProcessDidTerminate={() => { web.current?.reload(); }}
        onRenderProcessGone={() => { web.current?.reload(); }}
        onShouldStartLoadWithRequest={onNavigate}
        onOpenWindow={(e) => { Linking.openURL(e.nativeEvent.targetUrl).catch(() => {}); }}
        setSupportMultipleWindows
        onNavigationStateChange={(n) => { canGoBack.current = n.canGoBack; }}
        injectedJavaScriptBeforeContentLoaded={`${flagsJs}${insetJs}`}
        onLoadEnd={() => {
          inject(flagsJs + insetJs); setLoaded(true);
          // Push: already allowed? hand over the token. A cold-start tap is routed a beat later, once the page's hooks exist.
          pushSync(false); setTimeout(pushOpenSend, 1500);
        }}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        allowsFullscreenVideo={false}
        bounces={false}
        overScrollMode="never"
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        hideKeyboardAccessoryView
        // (Text interaction stays ON: turning it off also stops typing in every input on iOS — Vidrip's sign-in, the
        // game's chat. The game blocks text selection itself, in CSS.)
        webviewDebuggingEnabled={__DEV__}
        // The camera is native; the page asks only for the microphone (voice chat), which the OS prompt guards.
        mediaCapturePermissionGrantType="grant"
      />
      {camOn && <FaceFeed active={foreground} layout={layout} send={(json) => inject(`window.__sbFace&&window.__sbFace(${json})`)}
        fail={(why) => inject(`window.__sbCam&&window.__sbCam('error',${JSON.stringify(why)})`)} />}
      <Splash ready={loaded} />
    </View>
  );
}

/**
 * The launch art (the iOS launch screen's picture, LaunchScreen.storyboard): key art, logo, "Powered by Vidrip Mimic".
 * It stays over the WebView until the game's page has loaded (or 10 s at most), then fades out, so the launch screen
 * runs straight into the game instead of a blank page. On Android it follows the system splash (icon on night).
 */
function Splash({ ready }: { ready: boolean }) {
  const fade = useRef(new Animated.Value(1)).current;
  const [gone, setGone] = useState(false);
  const [late, setLate] = useState(false);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  useEffect(() => { const t = setTimeout(() => setLate(true), 10000); return () => clearTimeout(t); }, []);
  useEffect(() => {
    if (!(ready || late) || gone) { return; }
    // (A beat after the page loads, so its own first frame is drawn under the art before the fade.)
    const t = setTimeout(() => Animated.timing(fade, { toValue: 0, duration: 450, useNativeDriver: true }).start(() => setGone(true)), 350);
    return () => clearTimeout(t);
  }, [ready, late, gone, fade]);
  if (gone) { return null; }
  const logoW = Math.min(width * 0.82, 460);
  const logoH = (logoW * 672) / 1212;
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.splash, { opacity: fade }]}>
      {/* (An explicit size: Android's image view zoomed the art far past "cover" when it was only absoluteFill.) */}
      <Image source={require('./assets/launch/launch-bg.jpg')} style={{ position: 'absolute', left: 0, top: 0, width, height }} resizeMode="cover" resizeMethod="resize" />
      <Image source={require('./assets/launch/launch-logo.png')} resizeMode="contain"
        style={{ position: 'absolute', width: logoW, height: logoH, left: (width - logoW) / 2, top: height * 0.19 - logoH / 2 }} />
      <Image source={require('./assets/launch/launch-credit.png')} resizeMode="contain"
        style={{ position: 'absolute', width: 190, height: 53, left: (width - 190) / 2, bottom: insets.bottom + 30 }} />
    </Animated.View>
  );
}

/** The camera, the landmarker, and the picture over the page. Each frame's sample goes to the page as JSON. */
function FaceFeed({ active, layout, send, fail }: { active: boolean; layout: CamLayout | null; send: (json: string) => void; fail: (why: string) => void }) {
  const sendRef = useRef(send);
  sendRef.current = send;
  const failRef = useRef(fail);
  failRef.current = fail;
  const framesSeen = useRef(false);
  const mimic = useMimic({
    blendshapes: true,
    // The page runs the gestures; here only the numbers matter.
    gestures: [],
    landmarks: 'never',
    framing: null,
    onFrame: (_f, s) => { framesSeen.current = true; sendRef.current(packSample(s)); },
  });
  const show = !!layout && layout.visible;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.cam,
        show
          ? { left: layout!.x, top: layout!.y, width: layout!.w, height: layout!.h, borderRadius: layout!.radius, opacity: layout!.opacity, borderWidth: layout!.borderWidth ?? 0, borderColor: layout!.border ?? 'transparent' }
          // Hidden but still running (the game reads the face everywhere): parked far off screen at a normal size.
          // (Not shrunk or faded: Android's camera surface ignores a parent's size and opacity and draws a black box.)
          : styles.camHidden,
      ]}
    >
      <FrontCamera mimic={mimic} active={active} fail={(why) => failRef.current(why)} framesSeen={framesSeen} />
    </View>
  );
}

/**
 * MimicCamera, plus telling the page when the camera can't run (no front camera, a camera error), so the game says
 * so at once instead of timing out after 20 s with "The camera did not start".
 */
function FrontCamera({ mimic, active, fail, framesSeen }: { mimic: ReturnType<typeof useMimic>; active: boolean; fail: (why: string) => void; framesSeen: React.RefObject<boolean> }) {
  const device = useCameraDevice('front');
  const preview = usePreviewOutput();
  const failed = useRef(false);
  const report = useCallback((why: string) => { if (!failed.current) { failed.current = true; fail(why); } }, [fail]);
  useCamera({ isActive: active, device: device ?? 'front', outputs: [preview, mimic.frameOutput], onStarted: () => onStartedRef.current(), onError: (e) => report(`Camera error: ${e.message}`.slice(0, 160)) });
  // A camera that runs but whose frames the tracker can't read (VisionCamera's getPixelBuffer throws "Failed to read
  // HardwareBuffer bytes" on some GPUs / drivers, and on the emulator) never produces a sample: the error stays inside
  // the frame worklet. So: started, yet no frame within 6 s = say so.
  const onStarted = useCallback(() => {
    setTimeout(() => { if (!framesSeen.current) { report('Camera frames unreadable: the camera runs but no frame reached the face tracker.'); } }, 6000);
  }, [report, framesSeen]);
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;
  // (The device list loads asynchronously: give it a moment before calling a missing front camera.)
  useEffect(() => {
    if (device) { return; }
    const t = setTimeout(() => report('This device has no front camera.'), 4000);
    return () => clearTimeout(t);
  }, [device, report]);
  return <NativePreviewView previewOutput={preview} style={StyleSheet.absoluteFill} resizeMode="cover" />;
}

/** A FaceSample as compact JSON: 3 decimals; of the mesh, only the 18 sparse points every gesture but expression
 *  geometry reads (blink, mouth, smile …), as sp: [index, x, y, …]. The page rebuilds the mesh from them. */
function packSample(s: FaceSample): string {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const lm = s.landmarks;
  const sp: number[] = [];
  if (lm && s.faceFound) { for (const i of SPARSE_INDICES) { sp.push(i, r4(lm[i * 3]), r4(lm[i * 3 + 1])); } }
  return JSON.stringify({
    t: Math.round(s.t * 10) / 10,
    faceFound: s.faceFound,
    aspect: r(s.aspect),
    mirrored: s.mirrored,
    blendshapes: s.blendshapes ? Array.from(s.blendshapes, r) : null,
    pose: s.pose ? { yaw: r(s.pose.yaw), pitch: r(s.pose.pitch), roll: r(s.pose.roll) } : null,
    ...(sp.length ? { sp } : {}),
    ...(s.centered === undefined ? {} : { centered: s.centered }),
  });
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#05070d' },
  web: { flex: 1, backgroundColor: '#05070d' },
  cam: { position: 'absolute', overflow: 'hidden', backgroundColor: '#000' },
  camHidden: { left: -5000, top: 0, width: 120, height: 160 },
  splash: { backgroundColor: '#0b0716' },
});
