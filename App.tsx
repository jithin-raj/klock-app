import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AppState,
  BackHandler,
  Image,
  Platform,
  PermissionsAndroid,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import {WebView as WebViewBase, WebViewMessageEvent} from 'react-native-webview';
import type {WebViewNavigation} from 'react-native-webview';
import messaging from '@react-native-firebase/messaging';
import DeviceInfo from 'react-native-device-info';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CookieManager from '@react-native-cookies/cookies';
import {applyGeofenceConfig, parseGeofenceData} from './src/geofence';

// react-native-webview@14 isn't yet typed for React 19's stricter JSX, which
// collapses the class component's props to `never`. Alias it to a properly typed
// component so prop/ref checking works. (Runtime behaviour is unchanged.)
const WebView = WebViewBase as unknown as React.ComponentType<
  React.ComponentProps<typeof WebViewBase> & React.RefAttributes<WebViewBase>
>;

const WEB_APP_URL = 'https://klock.vercel.app'; // <-- the Angular app URL

// Where we persist the WebView's web storage so the session survives the app being
// swiped from recents / killed by the OS. We mirror localStorage AND sessionStorage
// (plus non-HttpOnly cookies) and restore them before Angular boots — Angular gates
// "logged in" on sessionStorage/cookie state that a fresh app launch would otherwise
// wipe (it survives an F5 but not an app kill), which is what logs the user out.
const STATE_SNAPSHOT_KEY = 'klocky.webState.snapshot';

// Explicit auth handoff: Angular posts {type:'saveAuth', payload} on login, we
// persist it natively, and re-expose it as `window.__KLOCKY_AUTH__` before every
// page load so Angular can restore the session on startup (the app's token lives
// only in localStorage, on a different API domain than the cookie/session checks).
const AUTH_KEY = 'klocky.auth.payload';

// The login session is gated by a cookie (likely HttpOnly, so JS can't read it).
// We persist the WebView's cookies natively and re-set them with a long expiry
// before the page loads, so the session survives the app being killed. This is
// what actually keeps the user signed in across a swipe-from-recents.
const COOKIE_SNAPSHOT_KEY = 'klocky.cookies.snapshot';
const COOKIE_DOMAIN = WEB_APP_URL.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const USE_WEBKIT = Platform.OS === 'ios';
const LOADER_GIF = require('./assets/loader.gif');
const COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Runs in the page after each load: mirror web storage back to native on every
// write (so the saved copy is always current, even right before an abrupt kill).
const CAPTURE_HOOK = `
(function () {
  if (window.__klockyHook) { return; }
  window.__klockyHook = true;
  function dump(storage) {
    var o = {};
    for (var i = 0; i < storage.length; i++) {
      var k = storage.key(i);
      o[k] = storage.getItem(k);
    }
    return o;
  }
  function snap() {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'state',
        local: dump(localStorage),
        session: dump(sessionStorage),
        cookie: document.cookie,
      }));
    } catch (e) {}
  }
  function wrap(storage) {
    var s = storage.setItem.bind(storage);
    var r = storage.removeItem.bind(storage);
    var c = storage.clear.bind(storage);
    storage.setItem = function (k, v) { s(k, v); snap(); };
    storage.removeItem = function (k) { r(k); snap(); };
    storage.clear = function () { c(); snap(); };
  }
  wrap(localStorage);
  wrap(sessionStorage);
  snap();
})();
true;`;

export default function App() {
  // Scale the loader relative to the shorter screen dimension so it looks
  // consistent across phones and tablets, and re-adapts on rotation.
  const {width: winW, height: winH} = useWindowDimensions();
  const loaderSize = Math.min(140, Math.max(80, Math.min(winW, winH) * 0.22));

  const webRef = useRef<WebViewBase>(null);
  const [, setDeviceId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const canGoBack = useRef(false);
  // undefined = still reading the saved snapshot; string = the JSON to restore
  // (or null if there's nothing saved yet). We hold the WebView until it's known.
  const [snapshot, setSnapshot] = useState<string | null | undefined>(undefined);
  // Becomes true once saved cookies have been re-applied to the WebView's cookie
  // store. We must hold the WebView until then, so the first request carries them.
  const [cookiesReady, setCookiesReady] = useState(false);
  // The saved auth payload (JSON string) handed over by Angular on login.
  // undefined = still loading; null = none saved. Held until known.
  const [auth, setAuth] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    AsyncStorage.getItem(STATE_SNAPSHOT_KEY)
      .then(v => setSnapshot(v))
      .catch(() => setSnapshot(null));
    AsyncStorage.getItem(AUTH_KEY)
      .then(v => setAuth(v))
      .catch(() => setAuth(null));
  }, []);

  // Restore saved cookies into the WebView before it loads, re-stamping each with
  // a fresh expiry so a former session cookie now persists across app restarts.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(COOKIE_SNAPSHOT_KEY);
        if (raw) {
          const cookies = JSON.parse(raw) as {name: string; value: string}[];
          const expires = new Date(Date.now() + COOKIE_TTL_MS).toISOString();
          for (const c of cookies) {
            await CookieManager.set(
              WEB_APP_URL,
              {
                name: c.name,
                value: c.value,
                domain: COOKIE_DOMAIN,
                path: '/',
                version: '1',
                expires,
                secure: true,
              },
              USE_WEBKIT,
            );
          }
        }
      } catch {
        // Best-effort; if restore fails the user just logs in again.
      } finally {
        setCookiesReady(true);
      }
    })();
  }, []);

  // Read the WebView's current cookies and persist them, so the latest session
  // (set by the server after login) is saved before the app can be killed.
  const captureCookies = useCallback(async () => {
    try {
      const all = await CookieManager.get(WEB_APP_URL, USE_WEBKIT);
      const list = Object.keys(all).map(name => ({
        name,
        value: all[name].value,
      }));
      if (list.length) {
        await AsyncStorage.setItem(COOKIE_SNAPSHOT_KEY, JSON.stringify(list));
      }
    } catch {
      // Ignore; we'll try again on the next capture trigger.
    }
  }, []);

  // Inject the mobile flag + the saved auth payload + restore web storage as early
  // as possible, before Angular bootstraps, so it can restore the session on startup
  // and stay signed in. `window.__KLOCKY_AUTH__` is the explicit handoff; the storage
  // restore (localStorage/sessionStorage/non-HttpOnly cookies) is a belt-and-suspenders.
  const beforeLoad =
    'window.__IS_MOBILE__ = true;' +
    `window.__KLOCKY_AUTH__ = ${auth ? auth : 'null'};` +
    (snapshot
      ? `try{var d=${snapshot};` +
        'if(d.local){for(var k in d.local){if(Object.prototype.hasOwnProperty.call(d.local,k)){localStorage.setItem(k,d.local[k]);}}}' +
        'if(d.session){for(var k in d.session){if(Object.prototype.hasOwnProperty.call(d.session,k)){sessionStorage.setItem(k,d.session[k]);}}}' +
        "if(d.cookie){d.cookie.split('; ').forEach(function(c){if(c){document.cookie=c;}});}" +
        '}catch(e){}'
      : '') +
    ' true;';

  async function requestPermissions() {
    try {
      await messaging().requestPermission(); // iOS + Android 13 notifications
      if (Platform.OS === 'android') {
        const perms = [
          PermissionsAndroid.PERMISSIONS.CAMERA,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ];
        if (Platform.Version >= 33) {
          perms.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
        }
        // The WebView auto-grants getUserMedia/geolocation once the app holds
        // these OS permissions, so the web app's camera/location code just works.
        await PermissionsAndroid.requestMultiple(perms);
        // Background location must be requested separately, AFTER fine location,
        // and (Android 11+) only sends the user to settings for "Allow all the
        // time" — required for geofence EXIT to fire when the app is killed.
        const fine = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        );
        const bgPerm = (PermissionsAndroid.PERMISSIONS as Record<string, string>)
          .ACCESS_BACKGROUND_LOCATION;
        if (fine && bgPerm) {
          await PermissionsAndroid.request(bgPerm as never);
        }
      }
    } catch {
      // Permission flow is best-effort; the web app still works without push.
    }
  }

  async function pushDeviceInfo() {
    try {
      const id = await DeviceInfo.getUniqueId();
      setDeviceId(id);
      const fcmToken = await messaging().getToken();
      const platform = Platform.OS; // 'android' | 'ios'
      webRef.current?.injectJavaScript(
        `window.dispatchEvent(new CustomEvent('klocky:device', { detail: ${JSON.stringify(
          {deviceId: id, platform, fcmToken},
        )} })); true;`,
      );
    } catch {
      // FCM may be unavailable (e.g. no Google Play services); fail silently.
    }
  }

  function navigateTo(route?: string) {
    if (!route) {
      return;
    }
    webRef.current?.injectJavaScript(
      `window.dispatchEvent(new CustomEvent('klocky:navigate', { detail: ${JSON.stringify(
        {route},
      )} })); true;`,
    );
  }

  useEffect(() => {
    requestPermissions();

    // Token refresh -> re-send so Angular re-registers.
    const unsub = messaging().onTokenRefresh(() => pushDeviceInfo());

    // Foreground push -> let the web app show an in-app toast (optional).
    const unsubMsg = messaging().onMessage(async m => {
      // A `geofence` data message (re)configures the native geofence.
      if (m?.data?.type === 'geofence') {
        applyGeofenceConfig(parseGeofenceData(m.data as Record<string, string>));
        return;
      }
      webRef.current?.injectJavaScript(
        `window.dispatchEvent(new CustomEvent('klocky:push', { detail: ${JSON.stringify(
          m.data ?? {},
        )} })); true;`,
      );
    });

    // Notification tap (background) -> deep-link the web app to data.route.
    const unsubOpen = messaging().onNotificationOpenedApp(m =>
      navigateTo(m?.data?.route as string | undefined),
    );
    // Cold start from a tapped notification.
    messaging()
      .getInitialNotification()
      .then(m => navigateTo(m?.data?.route as string | undefined));

    return () => {
      unsub();
      unsubMsg();
      unsubOpen();
    };
  }, []);

  // Hardware back button (Android) -> navigate back inside the WebView.
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack.current) {
        webRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  // Persist the latest web storage so it survives the app being killed. Keep the
  // in-memory `snapshot` in sync too, so a same-session WebView reload restores it.
  function saveSnapshot(json: string) {
    setSnapshot(json);
    AsyncStorage.setItem(STATE_SNAPSHOT_KEY, json).catch(() => {});
  }

  // Persist / clear the explicit auth payload handed over by Angular.
  function saveAuth(payload: unknown) {
    const json = JSON.stringify(payload ?? {});
    setAuth(json);
    AsyncStorage.setItem(AUTH_KEY, json).catch(() => {});
  }
  function clearAuth() {
    setAuth(null);
    AsyncStorage.removeItem(AUTH_KEY).catch(() => {});
  }

  // Messages from the Angular app.
  function onMessage(e: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'saveAuth') {
        saveAuth(msg.payload);
        return;
      }
      if (msg.type === 'clearAuth') {
        clearAuth();
        return;
      }
      if (msg.type === 'state') {
        saveSnapshot(
          JSON.stringify({
            local: msg.local ?? {},
            session: msg.session ?? {},
            cookie: msg.cookie ?? '',
          }),
        );
        return;
      }
      if (msg.type === 'requestDevice' || msg.type === 'loggedIn') {
        pushDeviceInfo();
      }
      // On logout Angular should also post {type:'clearAuth'} so the saved token
      // is removed and the user isn't auto-restored on next launch.
    } catch {}
  }

  // Final flush when the app is backgrounded (often the last event before a
  // swipe-from-recents kill): ask the page to push its current web storage.
  useEffect(() => {
    const flush =
      'try{function dump(s){var o={};for(var i=0;i<s.length;i++){var k=s.key(i);o[k]=s.getItem(k);}return o;}' +
      "window.ReactNativeWebView.postMessage(JSON.stringify({type:'state'," +
      'local:dump(localStorage),session:dump(sessionStorage),cookie:document.cookie}));}catch(e){} true;';
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        webRef.current?.injectJavaScript(flush);
        captureCookies();
      }
    });
    return () => sub.remove();
  }, [captureCookies]);

  function onNavStateChange(nav: WebViewNavigation) {
    canGoBack.current = nav.canGoBack;
    // Capture cookies after navigations (e.g. the post-login redirect that sets
    // the session cookie) so the saved copy reflects the latest session.
    captureCookies();
  }

  function reload() {
    setError(false);
    setLoading(true);
    webRef.current?.reload();
  }

  function onRefresh() {
    setRefreshing(true);
    webRef.current?.reload();
    setRefreshing(false);
  }

  // Wait until the saved storage + auth payload have been read and cookies have
  // been re-applied, so everything is in place before Angular bootstraps (avoids a
  // flash of the login screen and ensures the first request carries the session).
  if (snapshot === undefined || auth === undefined || !cookiesReady) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.loaderOverlay}>
          <Image
            source={LOADER_GIF}
            style={{width: loaderSize, height: loaderSize}}
            resizeMode="contain"
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.flex}>
      {error ? (
        <ScrollView
          contentContainerStyle={styles.center}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }>
          <View style={styles.errIcon}>
            <Text style={styles.errIconText}>!</Text>
          </View>
          <Text style={styles.errTitle}>No internet connection</Text>
          <Text style={styles.errBody}>
            Klock couldn't load. Check your Wi-Fi or mobile data and try again.
          </Text>
          <TouchableOpacity
            style={styles.btn}
            activeOpacity={0.85}
            onPress={reload}>
            <Text style={styles.btnText}>Try again</Text>
          </TouchableOpacity>
          <Text style={styles.errHint}>Pull down to refresh</Text>
        </ScrollView>
      ) : (
        <>
          <WebView
            ref={webRef}
            source={{uri: WEB_APP_URL}}
            injectedJavaScriptBeforeContentLoaded={beforeLoad}
            injectedJavaScript={CAPTURE_HOOK}
            onMessage={onMessage}
            onNavigationStateChange={onNavStateChange}
            onLoadEnd={() => {
              setLoading(false);
              captureCookies();
            }}
            onError={() => {
              setError(true);
              setLoading(false);
            }}
            // Let the web app use camera + geolocation:
            geolocationEnabled
            mediaCapturePermissionGrantType="grant" // iOS
            allowsInlineMediaPlayback
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            pullToRefreshEnabled
            startInLoadingState
          />
          {loading && (
            <View style={styles.loaderOverlay} pointerEvents="none">
              <Image
            source={LOADER_GIF}
            style={{width: loaderSize, height: loaderSize}}
            resizeMode="contain"
          />
            </View>
          )}
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1, backgroundColor: '#fff'},
  loaderOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  center: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  errIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#e8f5ec',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  errIconText: {fontSize: 40, fontWeight: '800', color: '#1f8a4c'},
  errTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
    color: '#111',
    textAlign: 'center',
  },
  errBody: {
    fontSize: 15,
    lineHeight: 21,
    color: '#555',
    textAlign: 'center',
    marginBottom: 24,
    maxWidth: 300,
  },
  btn: {
    backgroundColor: '#1f8a4c',
    paddingHorizontal: 32,
    paddingVertical: 13,
    borderRadius: 10,
  },
  btnText: {color: '#fff', fontWeight: '700', fontSize: 15},
  errHint: {fontSize: 12, color: '#9aa0a6', marginTop: 16},
});
