package com.klockymobile.geofence

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the JS "GeofenceExit" headless task (registered in index.js) when the user
 * leaves the geofence, even if the app is not in the foreground / has been killed.
 */
class GeofenceEventService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
    return HeadlessJsTaskConfig(
        "GeofenceExit",
        Arguments.createMap(),
        30000, // timeout (ms)
        true, // allowed to run in foreground
    )
  }
}
