import {NativeModules, Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DeviceInfo from 'react-native-device-info';

const {GeofenceModule} = NativeModules as {
  GeofenceModule?: {
    register(id: string, lat: number, lng: number, radius: number): Promise<boolean>;
    remove(): Promise<boolean>;
  };
};

const GEOFENCE_ID = 'klocky-workarea';

// Auth payload key mirrored from App.tsx — used only to read the (still valid)
// token so the clock-out call is authenticated. We never clear it here: leaving
// the work area clocks the user out, it does NOT sign them out.
const AUTH_KEY = 'klocky.auth.payload';

// Clock-out endpoint. POST with no body; the user is identified from the token.
const CLOCKOUT_URL = 'https://klock-api.onrender.com/api/attendance/clock-out';

export type GeofenceConfig = {
  enabled: boolean;
  lat?: number;
  lng?: number;
  radius?: number; // metres
};

/** Parse a geofence config delivered as an FCM data message (all strings). */
export function parseGeofenceData(data: Record<string, string> = {}): GeofenceConfig {
  return {
    enabled: data.enabled === 'true' || data.enabled === '1',
    lat: data.lat != null ? parseFloat(data.lat) : undefined,
    lng: data.lng != null ? parseFloat(data.lng) : undefined,
    radius: data.radius != null ? parseFloat(data.radius) : undefined,
  };
}

/** Register or clear the native geofence based on the org/user config. */
export async function applyGeofenceConfig(cfg: GeofenceConfig): Promise<void> {
  if (Platform.OS !== 'android' || !GeofenceModule) {
    return; // iOS region monitoring is a follow-up.
  }
  const valid =
    cfg.enabled &&
    typeof cfg.lat === 'number' &&
    typeof cfg.lng === 'number' &&
    typeof cfg.radius === 'number' &&
    cfg.radius > 0;
  try {
    if (valid) {
      await GeofenceModule.register(GEOFENCE_ID, cfg.lat!, cfg.lng!, cfg.radius!);
    } else {
      await GeofenceModule.remove();
    }
  } catch {
    // Best-effort; missing background-location permission will reject here.
  }
}

/**
 * Headless task body: runs when the user leaves the geofence, even if the app
 * has been killed. Calls the clock-out API with the still-valid token. The
 * server identifies the user from the token and de-dupes (the call is safe to
 * fire multiple times). It then pushes the clock-out status back via FCM, which
 * displays to the user (system tray when backgrounded/killed). The session is
 * left untouched — the user stays signed in until their token expires.
 */
export async function onGeofenceExit(): Promise<void> {
  let token: string | undefined;
  try {
    const raw = await AsyncStorage.getItem(AUTH_KEY);
    token = raw ? JSON.parse(raw)?.token : undefined;
  } catch {}

  if (!token) {
    return; // No token handed over by Angular yet — nothing we can authenticate.
  }

  let deviceId = '';
  try {
    deviceId = await DeviceInfo.getUniqueId();
  } catch {}

  try {
    await fetch(CLOCKOUT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        source: 'geofence',
        deviceId,
        at: new Date().toISOString(),
      }),
    });
  } catch {
    // Best-effort; if offline the clock-out simply doesn't fire this time.
  }
}
