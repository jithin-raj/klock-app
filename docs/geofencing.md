# Geofence auto clock-out — integration spec

When a user (in an org/user that has geofencing enabled) leaves the configured
work area, the **native shell** calls the **punch-out API**. The server records
the clock-out and pushes the **status back via FCM**, which the user sees even if
the app was killed. **The login session is never touched** — the user stays
signed in until their token expires.

```
Server --FCM data{type:geofence}--> App registers native geofence
User leaves radius (EXIT)  ---->  OS fires receiver (even if app killed)
App (Headless JS) --POST punch-out (Bearer token)--> Server
Server --FCM notification(clock-out status)--> User sees it (tray/in-app)
```

## ⚠️ Token / user-id access — the critical integration point

**The native side can only use what the Angular app hands it.** It cannot read or
decrypt the WebView's `localStorage`, so it has no token, user id, or anything
else unless Angular explicitly passes it over the bridge.

So Angular must, on login (and on every token refresh), post the **plaintext**
auth data the punch-out API needs:

```ts
// After successful login, and again whenever the token is refreshed:
(window as any).ReactNativeWebView?.postMessage(JSON.stringify({
  type: 'saveAuth',
  payload: {
    token: rawBearerToken,   // the ACTUAL token the API accepts (not the encrypted blob)
    userId: currentUser.id,  // include whatever punch-out needs
    employeeId: currentUser.employeeId,
    orgId: currentUser.orgId,
  },
}));
```

The shell stores this payload and, on geofence exit, sends:
- `Authorization: Bearer <token>` header
- body: `{ reason: 'geofence_exit', deviceId, at, ...any ids you included }`

**Key points**
- The `token` must be the **decrypted/usable bearer token** — native can't decrypt
  Angular's encrypted localStorage value.
- If punch-out resolves the user from the token, you don't need `userId`. If it
  needs an explicit id, include it in `payload` (native forwards the whole payload).
- If the token can expire, **re-post `saveAuth` on refresh** so the stored copy
  stays valid. (A long-lived 30-day token avoids this.)
- On logout, post `{type:'clearAuth'}` so a stale token isn't used.

## Angular changes

| # | When | Do |
|---|---|---|
| 1 | On login + token refresh | `postMessage({type:'saveAuth', payload:{token, userId, …}})` (see above) |
| 2 | On logout | `postMessage({type:'clearAuth'})` |
| 3 | (Optional) | If geofence settings are edited in the web app, tell your backend so it re-sends the geofence FCM (below) |

No Angular code is needed to *register* the geofence or call punch-out — the shell
does that. Angular's only job is handing over the token/ids.

## Server changes

### 1. Push the geofence config (FCM **data** message)
After the device registers (existing `POST /api/mobile/register-device` with
`deviceId`, `platform`, `fcmToken`) — **if the org/user has geofencing enabled** —
send a **data** message to that `fcmToken`:

```json
{
  "data": {
    "type": "geofence",
    "enabled": "true",
    "lat": "10.0159",
    "lng": "76.3419",
    "radius": "200"          // metres
  }
}
```
- Re-send whenever the geofence/radius changes.
- To **turn it off**, send `"enabled": "false"` (the shell removes the geofence).
- Must be a **data** message (no `notification` block) so the background handler
  processes it while the app is closed.

### 2. Clock-out endpoint
The shell calls (see [src/geofence.ts](../src/geofence.ts)):
```
POST https://klock-api.onrender.com/api/attendance/clock-out
Authorization: Bearer <token>
```
- **No body** — the user is identified from the bearer token.
- Validate the token as usual; record the clock-out.

### 3. Push the clock-out status back (FCM **notification** message)
After a successful punch-out, send a **notification** message to the device so it
displays even when the app is killed:
```json
{
  "notification": {
    "title": "Clocked out",
    "body": "You left the work area, so you were clocked out at 5:30 PM."
  },
  "data": { "type": "clockOutStatus" }
}
```
- Notification messages are shown by the OS tray automatically when the app is
  backgrounded/killed.
- In the foreground the shell forwards the data to the web app via the
  `klocky:push` event, so Angular can show an in-app toast if desired.

## Device / user requirement
The user must grant **"Allow all the time"** location (background). Android shows
this as a separate prompt → Settings. Without it, EXIT won't fire when the app is
closed.

## Platform / behaviour notes
- **Android only** so far. iOS needs Core Location region monitoring + "Always"
  permission (follow-up).
- Geofence exit detection has a typical **~1–3 min OS latency** (Android batches
  geofence events for battery) — it is not instant.
- Needs GPS / Google Play Services on the device.
