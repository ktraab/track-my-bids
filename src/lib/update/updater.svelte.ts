/** In-app updates: look for a newer release, and install it only when the user clicks. */

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** The slice of @tauri-apps/plugin-updater's Update that we use. */
export interface FoundUpdate {
  version: string;
  body?: string;
  downloadAndInstall(onEvent?: (e: DownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
}
export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export interface UpdaterDeps {
  check: () => Promise<FoundUpdate | null>;
  relaunch: () => Promise<void>;
  now: () => number;
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'current' // last manual check found nothing newer
  | 'available'
  | 'installing'
  | 'restarting'
  | 'error'; // last manual check failed (see error)

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // The updater reports a missing/unreachable latest.json as a fetch or JSON error.
  if (/fetch|sending request|network|connect|timed? ?out|dns|offline/i.test(msg)) return 'Couldn’t reach the update server. Check your internet connection.';
  return msg;
}

export class Updater {
  status = $state<UpdateStatus>('idle');
  version = $state<string | null>(null);
  notes = $state<string | null>(null);
  error = $state<string | null>(null);
  /** 0–1 while downloading when the size is known, otherwise null. */
  progress = $state<number | null>(null);
  /** Hides the banner for this version until the next launch. */
  dismissed = $state<string | null>(null);

  #update: FoundUpdate | null = null;
  #lastCheck = -Infinity;
  #deps: UpdaterDeps;

  constructor(deps: UpdaterDeps) {
    this.#deps = deps;
  }

  get busy() {
    return this.status === 'checking' || this.status === 'installing' || this.status === 'restarting';
  }

  get showBanner() {
    return (this.status === 'available' && this.dismissed !== this.version) || this.status === 'installing' || this.status === 'restarting';
  }

  /** Background check: quiet on failure, and at most once per CHECK_EVERY_MS. */
  async maybeCheck() {
    if (this.#deps.now() - this.#lastCheck < CHECK_EVERY_MS) return;
    await this.#check(false);
  }

  /** "Check for updates" button: reports the outcome, including failures. */
  checkNow() {
    return this.#check(true);
  }

  async #check(manual: boolean) {
    if (this.busy) return;
    // Once an update is found there's nothing newer to look for until it's installed.
    if (this.status === 'available' && !manual) return;
    this.status = 'checking';
    if (manual) this.error = null;
    this.#lastCheck = this.#deps.now();
    try {
      const found = await this.#deps.check();
      if (found) {
        if (this.#update && this.#update !== found) await this.#update.close().catch(() => {});
        this.#update = found;
        this.version = found.version;
        this.notes = found.body?.trim() || null;
        this.status = 'available';
      } else {
        this.status = this.#update ? 'available' : manual ? 'current' : 'idle';
      }
    } catch (e) {
      console.error('[updater]', e);
      if (manual) this.error = errorText(e);
      // A failed re-check doesn't take back an update we already found.
      this.status = this.#update ? 'available' : manual ? 'error' : 'idle';
    }
  }

  dismiss() {
    this.dismissed = this.version;
  }

  async install() {
    const update = this.#update;
    if (!update || this.busy) return;
    this.status = 'installing';
    this.error = null;
    this.progress = null;
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data.contentLength ?? 0;
        else if (e.event === 'Progress') {
          done += e.data.chunkLength;
          this.progress = total > 0 ? Math.min(1, done / total) : null;
        } else this.progress = total > 0 ? 1 : null;
      });
      // Windows exits inside downloadAndInstall to run the installer; macOS needs a relaunch.
      this.status = 'restarting';
      await this.#deps.relaunch();
    } catch (e) {
      console.error('[updater]', e);
      this.error = `Update failed: ${errorText(e)}`;
      this.status = 'available'; // banner stays up with the error and a retry
      this.dismissed = null;
    }
  }
}
