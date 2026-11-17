import { open, save, type DialogFilter } from '@tauri-apps/plugin-dialog';
import { mkdir, readFile, readTextFile, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { decodeText } from './domain/textDecode';

/** Ask where to save, then write. Returns the chosen path, or null if the user cancelled. */
export async function saveBytes(defaultPath: string, filters: DialogFilter[], bytes: Uint8Array): Promise<string | null> {
  const path = await save({ defaultPath, filters });
  if (!path) return null;
  await writeFile(path, bytes);
  return path;
}

export async function saveText(defaultPath: string, filters: DialogFilter[], text: string): Promise<string | null> {
  const path = await save({ defaultPath, filters });
  if (!path) return null;
  await writeTextFile(path, text);
  return path;
}

export async function openText(filters: DialogFilter[]): Promise<{ path: string; text: string } | null> {
  const path = await open({ multiple: false, directory: false, filters });
  if (!path || Array.isArray(path)) return null;
  return { path, text: await readTextFile(path) };
}

export async function reveal(path: string): Promise<void> {
  await revealItemInDir(path);
}

/** Write an .ics into the app cache and open it with the default calendar app (Outlook, Apple Calendar, …). */
export async function openCalendarFile(fileStem: string, ics: string): Promise<void> {
  const dir = await join(await appCacheDir(), 'calendar');
  await mkdir(dir, { recursive: true });
  const path = await join(dir, `${fileStem}.ics`);
  await writeTextFile(path, ics);
  await openPath(path);
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Pick files and read them as text, detecting UTF-16/UTF-8/Windows-1252 (Outlook exports vary). */
export async function openTextFiles(filters: DialogFilter[]): Promise<{ path: string; name: string; text: string }[]> {
  const picked = await open({ multiple: true, directory: false, filters });
  if (!picked) return [];
  const paths = Array.isArray(picked) ? picked : [picked];
  return Promise.all(paths.map(async (path) => ({ path, name: baseName(path), text: decodeText(await readFile(path)) })));
}
