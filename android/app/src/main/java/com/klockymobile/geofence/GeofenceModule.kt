package com.klockymobile.geofence

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices

/**
 * JS bridge to register/remove a single circular geofence using the OS
 * GeofencingClient. EXIT transitions fire [GeofenceBroadcastReceiver] even when
 * the app has been swiped from recents / killed.
 */
class GeofenceModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val client by lazy { LocationServices.getGeofencingClient(reactContext) }

  private val pendingIntent: PendingIntent by lazy {
    val intent = Intent(reactContext, GeofenceBroadcastReceiver::class.java)
    val flags =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
    PendingIntent.getBroadcast(reactContext, 0, intent, flags)
  }

  override fun getName() = "GeofenceModule"

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun register(id: String, lat: Double, lng: Double, radius: Float, promise: Promise) {
    val geofence =
        Geofence.Builder()
            .setRequestId(id)
            .setCircularRegion(lat, lng, radius)
            .setExpirationDuration(Geofence.NEVER_EXPIRE)
            .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_EXIT)
            .build()
    val request =
        GeofencingRequest.Builder()
            // Don't fire EXIT immediately if already inside; only on a real crossing.
            .setInitialTrigger(0)
            .addGeofence(geofence)
            .build()
    client
        .addGeofences(request, pendingIntent)
        .addOnSuccessListener { promise.resolve(true) }
        .addOnFailureListener { promise.reject("geofence_register_failed", it) }
  }

  @ReactMethod
  fun remove(promise: Promise) {
    client
        .removeGeofences(pendingIntent)
        .addOnSuccessListener { promise.resolve(true) }
        .addOnFailureListener { promise.reject("geofence_remove_failed", it) }
  }
}
