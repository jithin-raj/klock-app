package com.klockymobile.geofence

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent

/**
 * Receives geofence transitions from the OS (works even when the app process is
 * dead). On EXIT it kicks off a Headless JS task so the JS side can call the
 * punch-out API. The clock-out status is shown to the user via an FCM message
 * the server sends back; the user's session is left untouched.
 */
class GeofenceBroadcastReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val event = GeofencingEvent.fromIntent(intent) ?: return
    if (event.hasError()) return
    if (event.geofenceTransition == Geofence.GEOFENCE_TRANSITION_EXIT) {
      val service = Intent(context, GeofenceEventService::class.java)
      context.startService(service)
      HeadlessJsTaskService.acquireWakeLockNow(context)
    }
  }
}
