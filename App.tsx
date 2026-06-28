import React, {useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Platform,
  PermissionsAndroid,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {WebView as WebViewBase, WebViewMessageEvent} from 'react-native-webview';
import type {WebViewNavigation} from 'react-native-webview';
import messaging from '@react-native-firebase/messaging';
import DeviceInfo from 'react-native-device-info';
import AsyncStorage from '@react-native-async-storage/async-storage';

// react-native-webview@14 isn't yet typed for React 19's stricter JSX, which
// collapses the class component's props to `never`. Alias it to a properly typed
// component so prop/ref checking works. (Runtime behaviour is unchanged.)
const WebView = WebViewBase as unknown as React.ComponentType<
  React.ComponentProps<typeof WebViewBase> & React.RefAttributes<WebViewBase>
>;

const WEB_APP_URL = 'https://klock.vercel.app'; // <-- the Angular app URL

// Where we persist the WebView's localStorage so the session survives the app
// being swiped from recents / killed by the OS. (Android WebView batches its own
// localStorage writes to disk and can drop the most recent ones on an abrupt kill,
// which logs the user out — we mirror it here and restore it before Angular boots.)
const LS_SNAPSHOT_KEY = 'klocky.localStorage.snapshot';

// Runs in the page after each load: mirror localStorage back to native on every
// write (so the saved copy is always current, even right before an abrupt kill).
const CAPTURE_HOOK = `
(function () {
  if (window.__klockyLSHook) { return; }
  window.__klockyLSHook = true;
  function snap() {
    try {
      var o = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        o[k] = localStorage.getItem(k);
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({type: 'ls', data: o}));
    } catch (e) {}
  }
  var _set = localStorage.setItem.bind(localStorage);
  var _rem = localStorage.removeItem.bind(localStorage);
  var _clr = localStorage.clear.bind(localStorage);
  localStorage.setItem = function (k, v) { _set(k, v); snap(); };
  localStorage.removeItem = function (k) { _rem(k); snap(); };
  localStorage.clear = function () { _clr(); snap(); };
  snap();
})();
true;`;

export default function App() {
  const webRef = useRef<WebViewBase>(null);
  const [, setDeviceId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const canGoBack = useRef(false);
  // undefined = still reading the saved snapshot; string = the JSON to restore
  // (or null if there's nothing saved yet). We hold the WebView until it's known.
  const [snapshot, setSnapshot] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    AsyncStorage.getItem(LS_SNAPSHOT_KEY)
      .then(v => setSnapshot(v))
      .catch(() => setSnapshot(null));
  }, []);

  // Inject the mobile flag + restore the saved localStorage as early as possible,
  // before Angular bootstraps, so its auth guard sees the token and stays signed in.
  const beforeLoad =
    'window.__IS_MOBILE__ = true;' +
    (snapshot
      ? `try{var d=${snapshot};for(var k in d){if(Object.prototype.hasOwnProperty.call(d,k)){localStorage.setItem(k,d[k]);}}}catch(e){}`
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

  // Persist the latest localStorage so it survives the app being killed. Keep the
  // in-memory `snapshot` in sync too, so a same-session WebView reload restores it.
  function saveSnapshot(json: string) {
    setSnapshot(json);
    AsyncStorage.setItem(LS_SNAPSHOT_KEY, json).catch(() => {});
  }

  // Messages from the Angular app.
  function onMessage(e: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'ls') {
        saveSnapshot(JSON.stringify(msg.data ?? {}));
        return;
      }
      if (msg.type === 'requestDevice' || msg.type === 'loggedIn') {
        pushDeviceInfo();
      }
      // 'loggedOut' handling (clear token) is done by the web app calling
      // /logout with deviceId.
    } catch {}
  }

  // Final flush when the app is backgrounded (often the last event before a
  // swipe-from-recents kill): ask the page to push its current localStorage.
  useEffect(() => {
    const flush =
      'try{var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);' +
      'o[k]=localStorage.getItem(k);}' +
      "window.ReactNativeWebView.postMessage(JSON.stringify({type:'ls',data:o}));}catch(e){} true;";
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        webRef.current?.injectJavaScript(flush);
      }
    });
    return () => sub.remove();
  }, []);

  function onNavStateChange(nav: WebViewNavigation) {
    canGoBack.current = nav.canGoBack;
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

  // Wait until the saved localStorage has been read, so it can be restored into
  // the WebView before Angular bootstraps (avoids a flash of the login screen).
  if (snapshot === undefined) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.loaderOverlay}>
          <ActivityIndicator size="large" />
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
          <Text style={styles.errTitle}>Can't reach Klocky</Text>
          <Text style={styles.errBody}>
            Check your internet connection and try again.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={reload}>
            <Text style={styles.btnText}>Retry</Text>
          </TouchableOpacity>
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
            onLoadEnd={() => setLoading(false)}
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
            pullToRefreshEnabled
            startInLoadingState
          />
          {loading && (
            <View style={styles.loaderOverlay} pointerEvents="none">
              <ActivityIndicator size="large" />
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
  errTitle: {fontSize: 18, fontWeight: '600', marginBottom: 8, color: '#111'},
  errBody: {fontSize: 14, color: '#555', textAlign: 'center', marginBottom: 20},
  btn: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  btnText: {color: '#fff', fontWeight: '600'},
});
