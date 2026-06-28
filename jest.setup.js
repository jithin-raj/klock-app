/* Mocks for native modules so component tests can render without a device. */

jest.mock('@react-native-firebase/messaging', () => {
  const messaging = () => ({
    requestPermission: jest.fn().mockResolvedValue(1),
    getToken: jest.fn().mockResolvedValue('test-fcm-token'),
    onTokenRefresh: jest.fn().mockReturnValue(() => {}),
    onMessage: jest.fn().mockReturnValue(() => {}),
    onNotificationOpenedApp: jest.fn().mockReturnValue(() => {}),
    getInitialNotification: jest.fn().mockResolvedValue(null),
    setBackgroundMessageHandler: jest.fn(),
  });
  return {__esModule: true, default: messaging};
});

jest.mock('react-native-device-info', () => ({
  __esModule: true,
  default: {getUniqueId: jest.fn().mockResolvedValue('test-device-id')},
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('react-native-webview', () => {
  const React = require('react');
  return {WebView: () => React.createElement('WebView')};
});
