import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import type { Notifier } from './scheduler';

export const tauriNotifier: Notifier = {
  async ensurePermission() {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === 'granted';
  },
  isGranted() {
    return isPermissionGranted();
  },
  async send(title, body) {
    // Call the plugin command directly (sendNotification() is fire-and-forget) so IPC errors surface.
    // Note: OS-level drops (notifications disabled in System Settings, Focus modes) are undetectable
    // on desktop; the plugin reports "granted" regardless.
    await invoke('plugin:notification|notify', { options: { title, body } });
  },
};

/** Opens the OS notification settings page (macOS by default, Windows via user agent). */
export async function openNotificationSettings() {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  const win = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
  await openUrl(win ? 'ms-settings:notifications' : 'x-apple.systempreferences:com.apple.preference.notifications');
}
