import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Updater } from './updater.svelte';

export const updater = new Updater({ check, relaunch, now: () => Date.now() });

/** Background checks run only in release builds; "Check for updates" works everywhere. */
export const autoCheck = import.meta.env.PROD && import.meta.env.TAURI_ENV_DEBUG !== 'true';
