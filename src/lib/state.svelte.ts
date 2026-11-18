import type { Sql } from './db/sql';
import { migrate } from './db/migrations';
import { createBidRepo, type BidPatch } from './db/bids';
import { createMilestoneRepo, type MilestonePatch, type NewMilestoneInput } from './db/milestones';
import { createChecklistRepo } from './db/checklist';
import { createSettingsRepo } from './db/settings';
import { createNotificationLogRepo, type FiredNotification } from './db/notificationLog';
import { createContactRepo, type ContactWithBids } from './db/contacts';
import { createBackupRepo } from './db/backup';
import { importContacts, importedUids, runImportPlan } from './db/importer';
import type { ImportPlan } from './domain/importClassify';
import type { ContactInput } from './domain/contacts';
import type { Bid, BidWithChildren, ContactRole, NewBidInput } from './domain/types';
import { createTeamController, LOCAL_TEAM_STATE, type TeamState } from './sync/team';
import { createSupabaseRemote } from './sync/supabase';
import { encodeJoinCode } from './sync/joinCode';
import type { Role } from './sync/types';
import { canManage, isMine, memberName } from './domain/ownership';
import { isoNow } from './db/ids';
import {
  DEFAULT_REPORT_FILTERS, describeFilters, filterReportRows, reportFileName, summarizeByStage, toCsv,
  withReportDefaults, type ReportFilters, type ReportRow,
} from './domain/report';
import { parseBackup } from './domain/backup';
import { eventsForBid, googleCalendarUrl, outlookCalendarUrl, outlookPersonalCalendarUrl, safeFileStem, toIcs, type CalEvent } from './domain/calendar';
import { baseName, openCalendarFile, openText, reveal, saveBytes, saveText } from './files';
import { openUrl } from '@tauri-apps/plugin-opener';
import { enable as enableAutostart, disable as disableAutostart, isEnabled as autostartEnabled } from '@tauri-apps/plugin-autostart';
import { createChecklistTemplateRepo } from './db/checklistTemplate';
import { DEFAULT_TEMPLATE, type TemplateItem } from './domain/checklist';
import { applyNetworkFilters, EMPTY_NETWORK_FILTERS, withNetworkDefaults, type NetworkFilters } from './domain/networkFilters';
import { DEFAULT_NOTIFICATION_SETTINGS, withDefaults, type NotificationSettings } from './domain/settings';
import { snoozeUntil, stopMsFromKey, type SnoozeChoice } from './domain/snooze';

export type View = { name: 'network' } | { name: 'bid'; id: string } | { name: 'contacts' } | { name: 'settings' } | { name: 'import' };

type Repos = {
  bids: ReturnType<typeof createBidRepo>;
  milestones: ReturnType<typeof createMilestoneRepo>;
  checklist: ReturnType<typeof createChecklistRepo>;
  settings: ReturnType<typeof createSettingsRepo>;
  notificationLog: ReturnType<typeof createNotificationLogRepo>;
  contacts: ReturnType<typeof createContactRepo>;
  backup: ReturnType<typeof createBackupRepo>;
  templates: ReturnType<typeof createChecklistTemplateRepo>;
};

class AppState {
  bids = $state<BidWithChildren[]>([]);
  view = $state<View>({ name: 'network' });
  quickAddOpen = $state(false);
  error = $state<string | null>(null);
  ready = $state(false);
  nowMs = $state(Date.now());
  notifications = $state<FiredNotification[]>([]);
  notificationSettings = $state<NotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);
  notificationsAllowed = $state(true);
  panel = $state<null | 'inbox' | 'digest'>(null);
  contactList = $state<ContactWithBids[]>([]);
  reportRows = $state<ReportRow[]>([]);
  reportFilters = $state<ReportFilters>(DEFAULT_REPORT_FILTERS);
  notice = $state<{ text: string; path?: string } | null>(null);
  restoring = $state(false);
  openMenuId = $state<string | null>(null);
  networkFilters = $state<NetworkFilters>(EMPTY_NETWORK_FILTERS);
  checklistTemplate = $state<TemplateItem[]>(DEFAULT_TEMPLATE);
  launchAtLogin = $state(true);
  team = $state<TeamState>(LOCAL_TEAM_STATE);
  trash = $state<Bid[]>([]);
  /** Team user id, or null in Local mode (Local mode owns everything). */
  meId = $derived(this.team.mode === 'team' ? this.team.userId : null);
  myRole = $derived(this.team.mode === 'team' ? this.team.me?.role ?? null : null);
  unread = $derived(this.notifications.filter((n) => !n.read).length);
  #repos: Repos | null = null;
  #sql: Sql | null = null;
  #factory: (() => Promise<Sql>) | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #initializing = false;
  #queue: Promise<unknown> = Promise.resolve();
  #refreshSeq = 0;
  #notifSeq = 0;
  #team: ReturnType<typeof createTeamController> | null = null;

  async init(factory: () => Promise<Sql>) {
    if (this.#timer || this.#initializing) return;
    this.#factory = factory;
    this.#initializing = true;
    try {
      await this.#doInit(await factory());
    } catch (e) {
      this.error = `Could not open the database: ${e instanceof Error ? e.message : e}`;
    } finally {
      this.#initializing = false;
    }
  }

  /** Re-attempt initialization with the factory from the failed attempt. */
  async retryInit() {
    if (!this.#factory) return;
    this.error = null;
    await this.init(this.#factory);
  }

  get needsRetry() { return !this.ready && this.#factory !== null; }

  async #doInit(sql: Sql) {
    await migrate(sql);
    this.#sql = sql;
    const templates = createChecklistTemplateRepo(sql);
    this.#repos = {
      bids: createBidRepo(sql, undefined, undefined, () => templates.load(), () => this.meId),
      milestones: createMilestoneRepo(sql),
      checklist: createChecklistRepo(sql),
      settings: createSettingsRepo(sql),
      notificationLog: createNotificationLogRepo(sql),
      contacts: createContactRepo(sql),
      backup: createBackupRepo(sql),
      templates,
    };
    this.#team = createTeamController({
      sql,
      makeRemote: createSupabaseRemote,
      exclusive: (fn) => this.#exclusive(fn),
      now: isoNow,
      onState: (s) => { this.team = s; },
      onDataChanged: () => this.refresh().catch((e) => this.#fail(e)),
      onRejected: (msg) => { this.error = msg; },
    });
    try { await this.#team.load(); } catch (e) { this.#fail(e); }
    await this.refresh();
    this.notificationSettings = await this.#repos.settings.getNotifications();
    this.reportFilters = withReportDefaults(this.#parse(await this.#repos.settings.getRaw('export_filters')));
    this.networkFilters = withNetworkDefaults(this.#parse(await this.#repos.settings.getRaw('network_filters')));
    this.checklistTemplate = await this.#repos.templates.load();
    this.launchAtLogin = await this.#readLaunchAtLogin();
    await this.refreshNotifications();
    this.ready = true;
    this.#timer = setInterval(() => (this.nowMs = Date.now()), 60_000);
  }

  get repos(): Repos {
    if (!this.#repos) throw new Error('Database not ready');
    return this.#repos;
  }

  async refresh() {
    const seq = ++this.#refreshSeq;
    const [b, c] = await Promise.allSettled([this.repos.bids.listAll(), this.repos.contacts.list()]);
    if (seq !== this.#refreshSeq) return;
    if (b.status === 'fulfilled') this.bids = b.value;
    if (c.status === 'fulfilled') this.contactList = c.value;
    if (c.status === 'rejected') this.error = `Couldn't load contacts: ${c.reason instanceof Error ? c.reason.message : String(c.reason)}`;
    if (b.status === 'rejected') throw b.reason;
  }

  /** Plain (non-proxy) copy for pure domain code running outside components. */
  bidsSnapshot(): BidWithChildren[] {
    return $state.snapshot(this.bids) as BidWithChildren[];
  }

  /** Re-read notification settings from the DB (they may have changed since startup). */
  async reloadNotificationSettings() {
    this.notificationSettings = await this.repos.settings.getNotifications();
  }

  async refreshNotifications() {
    const seq = ++this.#notifSeq;
    try {
      const list = await this.repos.notificationLog.recent(50);
      if (seq === this.#notifSeq) this.notifications = list;
    } catch (e) {
      this.error = `Couldn't load notifications: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  #snoozeTarget(key: string, choice: SnoozeChoice, nowMs: number): string | null {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return snoozeUntil(choice, nowMs, zone, this.notificationSettings, stopMsFromKey(key) ?? undefined);
  }

  /** False when snoozing would push the reminder within 15 min of (or past) its stop. */
  canSnooze(key: string, choice: SnoozeChoice): boolean {
    return this.#snoozeTarget(key, choice, this.nowMs) !== null;
  }

  async snooze(key: string, choice: SnoozeChoice) {
    try {
      const until = this.#snoozeTarget(key, choice, Date.now());
      if (until === null) throw new Error('Too close to the deadline to snooze.');
      await this.repos.notificationLog.snooze(key, until);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    await this.refreshNotifications();
  }

  async markAllRead() {
    try {
      await this.repos.notificationLog.markAllRead();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    await this.refreshNotifications();
  }

  /** Serialize writes (+ refreshes) so they apply in order. Errors become a toast. Returns false if the write failed. */
  #run(fn: () => Promise<unknown>): Promise<boolean> {
    const p = this.#queue.then(() => this.#exec(fn));
    this.#queue = p;
    return p;
  }

  /**
   * Run on the write queue (so sync never interleaves with a user edit) and return the result.
   * Every local write to a synced table must go through this queue (#run uses it too): sync applies
   * server rows with outbox triggers paused, so a concurrent user write would not be recorded.
   */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  async #exec(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      try { await this.refresh(); } catch { /* best effort */ }
      return false;
    }
    this.#team?.poke();
    try {
      await this.refresh();
    } catch (e) {
      this.error = `Saved, but couldn't reload: ${e instanceof Error ? e.message : String(e)}`;
    }
    return true;
  }

  #parse(raw: string | null): unknown {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  #zone() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  #fail(e: unknown) { this.error = e instanceof Error ? e.message : String(e); }

  showContacts() { this.view = { name: 'contacts' }; }
  showImport() { this.view = { name: 'import' }; }
  showSettings() { this.view = { name: 'settings' }; }

  async saveNotificationSettings(s: NotificationSettings): Promise<boolean> {
    try {
      await this.repos.settings.setNotifications(withDefaults(s));
      await this.reloadNotificationSettings();
      this.notice = { text: 'Notification settings saved.' };
      return true;
    } catch (e) { this.#fail(e); return false; }
  }

  async setNetworkFilters(f: NetworkFilters) {
    this.networkFilters = f;
    try { await this.repos.settings.setRaw('network_filters', JSON.stringify(f)); } catch (e) { this.#fail(e); }
  }

  async saveChecklistTemplate(items: TemplateItem[]): Promise<boolean> {
    try {
      await this.repos.templates.save(items);
      this.checklistTemplate = await this.repos.templates.load();
      this.notice = { text: 'Checklist template saved. New bids will use it.' };
      return true;
    } catch (e) { this.#fail(e); return false; }
  }

  async resetChecklistTemplate() {
    try {
      await this.repos.templates.reset();
      this.checklistTemplate = await this.repos.templates.load();
      this.notice = { text: 'Checklist template reset to the default.' };
    } catch (e) { this.#fail(e); }
  }

  // Team
  #teamCtl() {
    if (!this.#team) throw new Error('Database not ready');
    return this.#team;
  }
  async teamJoin(code: string): Promise<boolean> {
    try { await this.#teamCtl().join(code); return true; } catch (e) { this.#fail(e); return false; }
  }
  teamJoinServer(url: string, key: string): Promise<boolean> {
    try { return this.teamJoin(encodeJoinCode({ url, key })); } catch (e) { this.#fail(e); return Promise.resolve(false); }
  }
  async teamSignUp(email: string, password: string, name: string): Promise<'signed_in' | 'confirm_email' | null> {
    try { return await this.#teamCtl().signUp(email, password, name); } catch (e) { this.#fail(e); return null; }
  }
  async teamSignIn(email: string, password: string): Promise<boolean> {
    try { await this.#teamCtl().signIn(email, password); return true; } catch (e) { this.#fail(e); return false; }
  }
  async teamDisconnect() {
    try {
      await this.#teamCtl().disconnect();
      this.trash = [];
      if (this.networkFilters.owner !== 'mine') await this.setNetworkFilters({ ...this.networkFilters, owner: 'mine' });
      await this.refresh();
    } catch (e) { this.#fail(e); }
  }
  async teamSetMember(id: string, role: Role, active: boolean): Promise<boolean> {
    try { await this.#teamCtl().setMember(id, role, active); return true; } catch (e) { this.#fail(e); return false; }
  }
  async teamRemoveMember(id: string): Promise<boolean> {
    try {
      await this.#teamCtl().removeMember(id);
      this.notice = { text: 'Member removed. Their bids are now yours.' };
      return true;
    } catch (e) { this.#fail(e); return false; }
  }
  teamSyncNow() {
    try { void this.#teamCtl().syncNow(); } catch (e) { this.#fail(e); }
  }
  async copyJoinCode() {
    const code = this.team.joinCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.notice = { text: 'Join code copied.' };
    } catch {
      this.notice = { text: 'Couldn’t copy automatically — select the code and copy it.' };
    }
  }
  memberName(id: string | null) { return memberName(this.team.members, id); }
  canManage(bid: Pick<Bid, 'ownerId'>) { return canManage(bid, this.meId, this.myRole); }
  /** Bids that drive this user's notifications, tray count and briefing. */
  myBidsSnapshot(): BidWithChildren[] {
    return this.bidsSnapshot().filter((d) => isMine(d.bid, this.meId));
  }
  async loadTrash() {
    try { this.trash = await this.repos.bids.listTrash(); } catch (e) { this.#fail(e); }
  }
  async restoreBid(id: string) {
    if (await this.#run(() => this.repos.bids.restore(id))) await this.loadTrash();
  }
  setOwner(bidId: string, ownerId: string) { return this.#run(() => this.repos.bids.setOwner(bidId, ownerId)); }

  #isRelease() { return import.meta.env.PROD && import.meta.env.TAURI_ENV_DEBUG !== 'true'; }

  /** Release builds report the real OS login item; otherwise (or if the OS check fails) the stored preference. */
  async #readLaunchAtLogin(): Promise<boolean> {
    const stored = (await this.repos.settings.getRaw('launch_at_login')) !== '0';
    if (!this.#isRelease()) return stored;
    try { return await autostartEnabled(); } catch { return stored; }
  }

  /**
   * Release builds change the OS login item first; dev/debug builds just store the preference.
   * On failure nothing changes and this returns false (the caller resets its checkbox).
   */
  async setLaunchAtLogin(on: boolean): Promise<boolean> {
    try {
      if (this.#isRelease()) {
        const enabled = await autostartEnabled();
        if (on && !enabled) await enableAutostart();
        if (!on && enabled) await disableAutostart();
      }
      await this.repos.settings.setRaw('launch_at_login', on ? '1' : '0');
      this.launchAtLogin = on;
      return true;
    } catch (e) { this.#fail(e); return false; }
  }

  // Contacts
  async addContactToBid(bidId: string, input: ContactInput, role: ContactRole): Promise<boolean> {
    return this.#run(async () => {
      const { id } = await this.repos.contacts.create(input);
      await this.repos.contacts.linkToBid(bidId, id, role);
    });
  }
  linkContact(bidId: string, contactId: string, role: ContactRole) { return this.#run(() => this.repos.contacts.linkToBid(bidId, contactId, role)); }
  unlinkContact(linkId: string) { return this.#run(() => this.repos.contacts.unlink(linkId)); }
  setContactRole(linkId: string, role: ContactRole) { return this.#run(() => this.repos.contacts.setRole(linkId, role)); }
  updateContact(id: string, patch: ContactInput) { return this.#run(() => this.repos.contacts.update(id, patch)); }
  removeContact(id: string) { return this.#run(() => this.repos.contacts.remove(id)); }

  // Import
  async importedUids(): Promise<Set<string>> {
    if (!this.#sql) throw new Error('Database not ready');
    return importedUids(this.#sql);
  }
  async importContacts(inputs: ContactInput[]): Promise<{ added: number; matched: number; failed: number; errors: string[] } | null> {
    const out = { added: 0, matched: 0, failed: 0, errors: [] as string[] };
    const ok = await this.#run(async () => { Object.assign(out, await importContacts(this.repos, inputs)); });
    if (!ok) return null;
    this.notice = { text: `Contacts: ${out.added} added, ${out.matched} already existed${out.failed ? `, ${out.failed} failed` : ''}` };
    if (out.failed) this.error = `Some contacts weren't imported: ${out.errors.join('; ')}${out.failed > out.errors.length ? ` (and ${out.failed - out.errors.length} more)` : ''}`;
    return out;
  }
  async runImport(plan: ImportPlan): Promise<{ bids: number; milestones: number; failed: string[] } | null> {
    const out = { bids: 0, milestones: 0, failed: [] as string[] };
    const ok = await this.#run(async () => { Object.assign(out, await runImportPlan(this.repos, plan)); });
    if (!ok) return null;
    this.notice = { text: `Imported ${out.bids} bid${out.bids === 1 ? '' : 's'} and ${out.milestones} milestone${out.milestones === 1 ? '' : 's'}` };
    if (out.failed.length) this.error = `Some items weren't imported: ${out.failed.join('; ')}`;
    return out;
  }

  // Report
  /** Returns an error message (shown inside the export dialog) or null. */
  async loadReportRows(): Promise<string | null> {
    try {
      this.reportRows = await this.repos.contacts.reportRows();
      return null;
    } catch (e) {
      return `Couldn't load contacts: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async exportContactsReport(filters: ReportFilters, format: 'xlsx' | 'csv'): Promise<{ path: string | null } | { error: string }> {
    const now = Date.now();
    const zone = this.#zone();
    let path: string | null;
    let count: number;
    try {
      const rows = filterReportRows(await this.repos.contacts.reportRows(), filters, now, zone);
      count = rows.length;
      const name = reportFileName(filters, now, zone, format);
      if (format === 'csv') {
        path = await saveText(name, [{ name: 'CSV', extensions: ['csv'] }], toCsv(rows));
      } else {
        const { contactsWorkbook } = await import('./export/contactsXlsx');
        const bytes = await contactsWorkbook(rows, summarizeByStage(rows), describeFilters(filters, now, zone));
        path = await saveBytes(name, [{ name: 'Excel workbook', extensions: ['xlsx'] }], bytes);
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    if (path) {
      this.notice = { text: `Saved ${count} row${count === 1 ? '' : 's'} to ${baseName(path)}`, path };
      try {
        this.reportFilters = filters;
        await this.repos.settings.setRaw('export_filters', JSON.stringify(filters));
      } catch { /* remembering filters is best effort; the export succeeded */ }
    }
    return { path };
  }

  // Backup
  async backupAll() {
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const data = await this.repos.backup.exportAll(new Date().toISOString());
      const path = await saveText(`TrackMyBids-Backup-${stamp}.tmb`, [{ name: 'TrackMyBids backup', extensions: ['tmb', 'json'] }],
        JSON.stringify(data, null, 2));
      if (path) this.notice = { text: `Backup saved to ${baseName(path)}`, path };
    } catch (e) { this.#fail(e); }
  }

  async restoreBackup() {
    if (this.restoring) return;
    if (this.team.mode === 'team') {
      this.error = 'Restore is turned off while connected to a team — it would overwrite your team’s data. Leave the team first.';
      return;
    }
    this.restoring = true;
    try {
      const file = await openText([{ name: 'TrackMyBids backup', extensions: ['tmb', 'json'] }]);
      if (!file) return;
      const backup = parseBackup(file.text);
      const out = { inserted: 0, updated: 0, skipped: 0 };
      const ok = await this.#run(async () => {
        Object.assign(out, await this.repos.backup.importAll(backup));
        await this.reloadNotificationSettings();
        // networkFilters are device-local (never restored), so they stay as they are.
        this.checklistTemplate = await this.repos.templates.load();
      });
      if (ok) this.notice = { text: `Restored: ${out.inserted} added, ${out.updated} updated, ${out.skipped} skipped.` };
    } catch (e) { this.#fail(e); } finally { this.restoring = false; }
  }

  // Calendar
  calendarEvents(bidId: string): CalEvent[] {
    const d = this.bids.find((x) => x.bid.id === bidId);
    return d ? eventsForBid($state.snapshot(d) as typeof d, Date.now(), this.notificationSettings) : [];
  }
  async addToCalendar(target: 'google' | 'outlook' | 'outlook_personal' | 'file', bidId: string, stopId?: string) {
    try {
      const all = this.calendarEvents(bidId);
      const events = stopId ? all.filter((e) => e.uid.startsWith(stopId.replace(/[^A-Za-z0-9-]/g, '-') + '@')) : all;
      if (!events.length) { this.notice = { text: 'Nothing upcoming to add (past or completed milestones are skipped).' }; return; }
      if (target === 'google') await openUrl(googleCalendarUrl(events[0]));
      else if (target === 'outlook') await openUrl(outlookCalendarUrl(events[0]));
      else if (target === 'outlook_personal') await openUrl(outlookPersonalCalendarUrl(events[0]));
      else {
        const d = this.bids.find((x) => x.bid.id === bidId)!;
        await openCalendarFile(safeFileStem(`${d.bid.agencyName} ${stopId ? events[0].title : d.bid.title}`), toIcs(events, Date.now()));
      }
    } catch (e) { this.#fail(e); }
  }
  async revealNotice() {
    if (this.notice?.path) await reveal(this.notice.path).catch((e) => this.#fail(e));
  }

  open(id: string) { this.view = { name: 'bid', id }; }
  home() {
    this.view = { name: 'network' };
    this.panel = null;
    this.quickAddOpen = false;
  }

  async createBid(input: NewBidInput): Promise<string | null> {
    const out = { id: '' };
    const ok = await this.#run(async () => { out.id = await this.repos.bids.create(input); });
    if (ok) {
      const created = this.bids.find((d) => d.bid.id === out.id);
      if (created && !applyNetworkFilters([created], this.networkFilters, this.meId).length) {
        this.notice = { text: 'Bid saved — hidden by your filters.' };
      }
      this.open(out.id);
    }
    return ok ? out.id : null;
  }
  updateBid(id: string, patch: BidPatch) { return this.#run(() => this.repos.bids.update(id, patch)); }
  async removeBid(id: string) { if (await this.#run(() => this.repos.bids.remove(id))) this.home(); }

  addMilestone(input: NewMilestoneInput) { return this.#run(() => this.repos.milestones.add(input)); }
  updateMilestone(id: string, patch: MilestonePatch) { return this.#run(() => this.repos.milestones.update(id, patch)); }
  removeMilestone(id: string) { return this.#run(() => this.repos.milestones.remove(id)); }

  addChecklistItem(bidId: string, text: string) { return this.#run(() => this.repos.checklist.add(bidId, text)); }
  toggleChecklistItem(id: string, done: boolean) { return this.#run(() => this.repos.checklist.setDone(id, done)); }
  removeChecklistItem(id: string) { return this.#run(() => this.repos.checklist.remove(id)); }
  moveChecklistItem(id: string, dir: -1 | 1) { return this.#run(() => this.repos.checklist.move(id, dir)); }
}

export const app = new AppState();
