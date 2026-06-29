/**
 * @format
 */

import {AppRegistry} from 'react-native';
import messaging from '@react-native-firebase/messaging';
import App from './App';
import {name as appName} from './app.json';
import {
  applyGeofenceConfig,
  parseGeofenceData,
  onGeofenceExit,
} from './src/geofence';

// Background / terminated push. A `geofence` data message (re)configures the
// native geofence even while the app is closed; other pushes show in the tray.
messaging().setBackgroundMessageHandler(async message => {
  if (message?.data?.type === 'geofence') {
    await applyGeofenceConfig(parseGeofenceData(message.data));
  }
});

// Runs when the user leaves the geofence, even if the app has been killed.
AppRegistry.registerHeadlessTask('GeofenceExit', () => onGeofenceExit);

AppRegistry.registerComponent(appName, () => App);
