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

## Bridge contract reference

| Direction | Mechanism | Messages |
|---|---|---|
| Native → Web | `injectJavaScript` | `window.__IS_MOBILE__ = true`; `klocky:device` {deviceId, platform, fcmToken}; `klocky:navigate` {route}; `klocky:push` {data} |
| Web → Native | `window.ReactNativeWebView.postMessage(JSON.stringify(...))` | `{type:'ready'}`, `{type:'requestDevice'}`, `{type:'loggedIn'}`, `{type:'loggedOut'}`, `{type:'ls', data}` |

## Session persistence (no Angular change needed)

The shell mirrors the WebView's `localStorage` into native storage on every write
(`{type:'ls'}`, sent automatically by an injected hook) and restores it **before the
page loads** on next launch. This keeps the Angular session alive when the app is
swiped from recents / killed by the OS — Android WebView otherwise batches its
localStorage writes and can drop the most recent ones on an abrupt kill. The token
stays wherever Angular already puts it in `localStorage`; the shell never reads or
parses it. (A deliberate "Clear data/storage" from app settings still logs out, by
OS design — nothing in the app sandbox survives that.)
