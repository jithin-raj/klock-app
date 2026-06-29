# Angular web-app changes for the mobile shell

Three small additions so the existing Angular app cooperates with the React Native shell.
The shell sets `window.__IS_MOBILE__ = true` and dispatches `klocky:device` / `klocky:navigate`
events; the app talks back via `window.ReactNativeWebView.postMessage(...)`.

Camera/location need **no Angular change** — existing `getUserMedia` / `navigator.geolocation`
calls run inside the WebView using the OS permissions the shell grants.

## a) Send the `isMobile` header (HTTP interceptor)

```ts
@Injectable()
export class MobileHeaderInterceptor implements HttpInterceptor {
  intercept(req: HttpRequest<any>, next: HttpHandler) {
    if ((window as any).__IS_MOBILE__) {
      req = req.clone({ setHeaders: { isMobile: 'true' } });
    }
    return next.handle(req);
  }
}
```

Register it in your providers:

```ts
{ provide: HTTP_INTERCEPTORS, useClass: MobileHeaderInterceptor, multi: true }
```

## b) Register the device after login

```ts
@Injectable({ providedIn: 'root' })
export class MobileBridgeService {
  private device?: { deviceId: string; platform: string; fcmToken: string };
  get deviceId() { return this.device?.deviceId; }

  constructor(private http: HttpClient, private router: Router) {
    window.addEventListener('klocky:device', (e: any) => {
      this.device = e.detail;
      if (this.isLoggedIn()) this.register();
    });
    window.addEventListener('klocky:navigate', (e: any) =>
      this.router.navigateByUrl(e.detail.route));
  }

  /** Call right after a successful login. */
  onLogin() {
    if ((window as any).__IS_MOBILE__) {
      (window as any).ReactNativeWebView?.postMessage(JSON.stringify({ type: 'loggedIn' }));
      if (this.device) this.register();
    }
  }

  private register() {
    if (!this.device) return;
    this.http.post('/api/mobile/register-device', this.device).subscribe();
  }
}
```

## c) Clear the device on logout

```ts
logout() {
  this.http.post('/api/users/auth/logout', {
    deviceId: this.bridge.deviceId,
    refreshToken: this.session.refreshToken,
  }).subscribe(() => this.session.clear());
}
```

## d) Keep the user signed in (mobile) — explicit auth handoff

The app's auth token lives only in `localStorage`, and the API is on a different
domain (`klock-api.onrender.com`) with no session cookie, so on a cold app launch
the WebView opens the root URL and Angular shows the **landing page** instead of
restoring the session. Fix it with a 3-line handoff to the native shell, which
persists the token across app kills and re-exposes it on every load.

**1. On successful login — hand the token to native:**

```ts
onLoginSuccess(authPayload: unknown) {
  // authPayload = whatever you need to restore the session, e.g. { token, user, ... }
  if ((window as any).__IS_MOBILE__) {
    (window as any).ReactNativeWebView?.postMessage(
      JSON.stringify({ type: 'saveAuth', payload: authPayload }));
  }
}
```

**2. On startup — restore the session from the native handoff (before routing):**

```ts
// APP_INITIALIZER, or AuthService constructor — runs on every app load.
restoreMobileSession(): boolean {
  const saved = (window as any).__KLOCKY_AUTH__;   // injected by the shell pre-load
  if ((window as any).__IS_MOBILE__ && saved) {
    this.setSession(saved);            // restore token/user into your auth state
    return true;                        // -> route guard sends user to the app, not landing
  }
  return false;
}
```

If your guards already read the token from `localStorage` (they do — an F5 stays
logged in), the simplest version is: on startup, if `__KLOCKY_AUTH__` exists, write
it back to `localStorage` under your normal key and **navigate to the home route**
so the user doesn't land on the login page.

**3. On logout — clear the saved token so the user isn't auto-restored:**

```ts
logout() {
  if ((window as any).__IS_MOBILE__) {
    (window as any).ReactNativeWebView?.postMessage(JSON.stringify({ type: 'clearAuth' }));
  }
  // ...existing logout / session.clear()...
}
```

## Bridge contract reference

| Direction | Mechanism | Messages |
|---|---|---|
| Native → Web | `injectJavaScript` | `window.__IS_MOBILE__ = true`; `window.__KLOCKY_AUTH__ = <payload｜null>`; `klocky:device` {deviceId, platform, fcmToken}; `klocky:navigate` {route}; `klocky:push` {data} |
| Web → Native | `window.ReactNativeWebView.postMessage(JSON.stringify(...))` | `{type:'ready'}`, `{type:'requestDevice'}`, `{type:'loggedIn'}`, `{type:'loggedOut'}`, `{type:'saveAuth', payload}`, `{type:'clearAuth'}`, `{type:'state', local, session, cookie}` |

## Session persistence (how the shell holds the token)

The shell persists the auth token natively in two complementary ways and restores
both **before the page loads**, so a cold launch looks like an F5 and the session
survives the app being swiped from recents / killed by the OS:

- **Explicit handoff (primary):** Angular posts `{type:'saveAuth', payload}` on login;
  the shell stores it and re-exposes it as `window.__KLOCKY_AUTH__` on every load.
- **Auto storage mirror (belt-and-suspenders):** the shell mirrors `localStorage`,
  `sessionStorage`, and cookies on every change (`{type:'state'}`) and re-applies
  them pre-load — including re-stamping cookies with a long expiry.

(A deliberate "Clear data/storage" from app settings still logs out, by OS design —
nothing in the app sandbox survives that.)
