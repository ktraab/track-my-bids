import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { TrayIcon } from '@tauri-apps/api/tray';
import { enable } from '@tauri-apps/plugin-autostart';
import { resourceDir } from '@tauri-apps/api/path';
import { isStableAppLocation } from '../domain/loginItem';
import { app } from '../state.svelte';
import { buildDigest } from '../domain/digest';
import { createScheduler } from './scheduler';
import { tauriNotifier } from './notifier';
import { updater, autoCheck } from '../update';

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
let started = false;
const unlisteners: UnlistenFn[] = [];

import.meta.hot?.dispose(() => {
  unlisteners.splice(0).forEach((u) => u());
  started = false;
});

async function updateTray() {
  const tray = await TrayIcon.getById('main');
  if (!tray) return;
  const dg = buildDigest(app.myBidsSnapshot(), Date.now(), zone(), app.notificationSettings);
  const n = dg.overdue.length + dg.today.length + dg.shipBy.length;
  // setTitle is a no-op on Windows; the tooltip below carries the count there.
  await tray.setTitle(n > 0 ? String(n) : null); // macOS: text next to the menu-bar icon
  await tray.setTooltip(n > 0 ? `TrackMyBids · ${n} need attention today` : 'TrackMyBids');
}

async function ensureAutostart() {
  // Only release builds register as a login item (never `tauri dev` or `tauri build --debug`).
  if (!import.meta.env.PROD || import.meta.env.TAURI_ENV_DEBUG === 'true') return;
  // Default on: enable when the user never chose (no pref) or chose on ('1'). Anything else —
  // in particular '0' from turning it off in Settings — means hands off. enable() rewrites the
  // login item every launch, so it follows the copy of the app that is actually running (after
  // moving or reinstalling it, or after a run from a temporary location left it pointing there).
  const pref = await app.repos.settings.getRaw('launch_at_login');
  if (pref !== null && pref !== '1') return;
  // Never point it at a translocated copy or a mounted .dmg; the next normal launch fixes it.
  if (!isStableAppLocation(await resourceDir())) return;
  await enable();
}

/** Call once after app.init succeeded. Safe to call again (no-op). */
export async function startRuntime() {
  if (started || !app.ready) return;
  started = true;
  try {
    await start();
  } catch (e) {
    unlisteners.splice(0).forEach((u) => u());
    started = false; // allow a later retry
    console.error('[runtime]', e);
    throw e;
  }
}

async function start() {
  app.notificationsAllowed = await tauriNotifier.ensurePermission().catch(() => false);

  const scheduler = createScheduler({
    now: () => Date.now(),
    zone,
    bids: () => app.myBidsSnapshot(),
    // Reloaded at the start of each tick, so this returns the fresh store value.
    settings: async () => app.notificationSettings,
    log: app.repos.notificationLog,
    notifier: tauriNotifier,
    onError: (e) => console.error('[scheduler]', e),
    onPermission: (granted) => { app.notificationsAllowed = granted; },
  });

  const onTick = async () => {
    app.nowMs = Date.now();
    await app.reloadNotificationSettings().catch((e) => console.error('[settings]', e));
    const fired = await scheduler.tick();
    if (fired.length) await app.refreshNotifications();
    await updateTray().catch((e) => console.error('[tray]', e));
    if (autoCheck) void updater.maybeCheck(); // throttled to every few hours; the first tick is at startup
  };

  unlisteners.push(await listen('scheduler-tick', onTick));
  unlisteners.push(await listen('tray-quick-add', () => { app.quickAddOpen = true; }));
  unlisteners.push(await listen('tray-digest', () => { app.panel = 'digest'; }));
  await ensureAutostart().catch((e) => console.error('[autostart]', e));
  await onTick();
}
