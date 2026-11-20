import { DateTime } from 'luxon';
import type { Sql } from './db/sql';
import { migrate } from './db/migrations';
import { createBidRepo, type BidPatch } from './db/bids';
import { createVendorQuoteRepo, type NewVendorQuote } from './db/vendorQuotes';
import { createQuoteLineRepo, type NewQuoteLine, type QuoteLinePatch } from './db/quoteLines';
import { createMilestoneRepo, type MilestonePatch, type NewMilestoneInput } from './db/milestones';
import { createChecklistRepo } from './db/checklist';
import { createSettingsRepo } from './db/settings';
import { createNotificationLogRepo, type FiredNotification } from './db/notificationLog';
import { createContactRepo, type ContactWithBids } from './db/contacts';
import { createBackupRepo } from './db/backup';
import { createExtractLabelRepo, type ExtractLabel } from './db/extractLabels';
import type { NewMilestoneInput as MilestoneInput } from './db/milestones';
import { extract, isEmptySuggestions, type Line, type Suggestions } from './domain/extract';
import { knownLabels, learnLabel } from './domain/extractLearn';
import { learnScopeHeading } from './domain/scopeSummary';
import { checkTagWord, TAG_FIELD_PREFIX } from './domain/scopeTags';
import type { LearnEvent } from './domain/docFill';
import { docKind, MAX_DOC_BYTES, readText, ReadError } from './extract/readText';
import { loadPdfjs } from './extract/pdfjs';
import { importContacts, importedUids, runImportPlan } from './db/importer';
import type { ImportPlan } from './domain/importClassify';
import type { ContactInput } from './domain/contacts';
import type { Bid, BidWithChildren, ContactRole, NewBidInput, NewQuoteInput, PricingMode, Stage } from './domain/types';
import { createTeamController, LOCAL_TEAM_STATE, type TeamState } from './sync/team';
import { createSupabaseRemote } from './sync/supabase';
import { encodeJoinCode } from './sync/joinCode';
import type { Role } from './sync/types';
import { canManage, isMine, memberName } from './domain/ownership';
import { isoNow } from './db/ids';
import {
  DEFAULT_REPORT_FILTERS, describeFilters, filterReportRows, reportFileName, summarizeByStage, toCsv,
  withOurPrice, withReportDefaults, type ReportFilters, type ReportRow,
} from './domain/report';
import { parseBackup } from './domain/backup';
import { eventsForBid, googleCalendarUrl, outlookCalendarUrl, outlookPersonalCalendarUrl, safeFileStem, toIcs, type CalEvent } from './domain/calendar';
import { baseName, fileSize, openCalendarFile, openText, pickDocument, readBytes, reveal, saveBytes, saveText } from './files';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { enable as enableAutostart, disable as disableAutostart, isEnabled as autostartEnabled } from '@tauri-apps/plugin-autostart';
import { createChecklistTemplateRepo } from './db/checklistTemplate';
import { DEFAULT_TEMPLATE, type TemplateItem } from './domain/checklist';
import {
  applyNetworkFilters, EMPTY_NETWORK_FILTERS, storedFilters, withNetworkDefaults, type FilterCtx, type NetworkFilters,
} from './domain/networkFilters';
import { nudgeMessage } from './domain/rfq';
import {
  inNeedsList, needsBaseKey, needsSnoozeUntil, needsYou, thresholdsFromSettings, type NeedsItem, type NeedsThresholds,
} from './domain/needsYou';
import { localToIso } from './domain/time';
import { DEFAULT_NOTIFICATION_SETTINGS, withDefaults, type NotificationSettings } from './domain/settings';
import { snoozeUntil, stopMsFromKey, type SnoozeChoice } from './domain/snooze';
import {
  DEFAULT_PRICING, gridVendors, parsePaste, pasteNotice, quoteTotal, seedMarkup, withPricingDefaults, type Markup, type PricingDefaults,
} from './domain/pricing';

/** A bid document being read into the New bid form. Only kept in memory: never stored. */
export interface DocImport {
  /** Bumped per document, so an open form knows to fill again. */
  seq: number;
  name: string;
  path: string;
  status: 'reading' | 'ready' | 'empty' | 'no_text' | 'error';
  lines: Line[];
  suggestions: Suggestions | null;
  /** status 'error': what went wrong, in words for the form. */
  error?: string;
}

/** A read failure in words for the New bid form. */
export function readErrorText(e: unknown): string {
  if (e instanceof ReadError) {
    if (e.code === 'pdf_unsupported') return 'PDF reading isn’t supported on this Mac — update macOS/Safari.';
    return e.message || 'Couldn’t read this file.';
  }
  return 'Couldn’t read this file.';
}

export type View = { name: 'network' } | { name: 'bid'; id: string } | { name: 'contacts' } | { name: 'settings' } | { name: 'import' };

type Repos = {
  bids: ReturnType<typeof createBidRepo>;
  milestones: ReturnType<typeof createMilestoneRepo>;
  vendorQuotes: ReturnType<typeof createVendorQuoteRepo>;
  quoteLines: ReturnType<typeof createQuoteLineRepo>;
  checklist: ReturnType<typeof createChecklistRepo>;
  settings: ReturnType<typeof createSettingsRepo>;
  notificationLog: ReturnType<typeof createNotificationLogRepo>;
  contacts: ReturnType<typeof createContactRepo>;
  backup: ReturnType<typeof createBackupRepo>;
  templates: ReturnType<typeof createChecklistTemplateRepo>;
  extractLabels: ReturnType<typeof createExtractLabelRepo>;
};

class AppState {
  bids = $state<BidWithChildren[]>([]);
  view = $state<View>({ name: 'network' });
  quickAddOpen = $state(false);
  docImport = $state<DocImport | null>(null);
  /** Never resets (docImport does on close), so a slow read can't land in a later form. */
  #docSeq = 0;
  /** Label phrases learned from documents (Settings → Document import). */
  extractLabels = $state<ExtractLabel[]>([]);
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
  /** Settings → Pricing: the markup a bid gets pinned with when its first line is added. */
  pricingDefaults = $state<PricingDefaults>(DEFAULT_PRICING);
  /** Needs-you thresholds (incl. Plan 2's follow-up clocks), from Settings → Notifications. */
  followUp = $derived<NeedsThresholds>(thresholdsFromSettings(this.notificationSettings));
  /** Needs-you snoozes on this device (key → ISO end). Never synced. */
  needsSnoozes = $state<Map<string, string>>(new Map());
  /** Team user id, or null in Local mode (Local mode owns everything). */
  meId = $derived(this.team.mode === 'team' ? this.team.userId : null);
  myRole = $derived(this.team.mode === 'team' ? this.team.me?.role ?? null : null);
  unread = $derived(this.notifications.filter((n) => !n.read).length);
  /** Team mode: ids of active members (empty in Local mode). An RFQ owned by anyone else counts as unclaimed. */
  activeMemberIds = $derived<ReadonlySet<string>>(new Set(
    this.team.mode === 'team' ? this.team.members.filter((m) => m.active).map((m) => m.id) : []));
  /** The Needs-you list: this user's rows (unowned, or owned by a deactivated teammate, count as mine), snoozes removed. */
  needs = $derived<NeedsItem[]>(needsYou(this.bids.filter((d) => inNeedsList(d.bid, this.meId, this.activeMemberIds)), {
    nowMs: this.nowMs,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    team: this.team.mode === 'team',
    followUp: this.followUp,
    snoozes: this.needsSnoozes,
    activeMemberIds: this.activeMemberIds,
  }));
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
      vendorQuotes: createVendorQuoteRepo(sql),
      quoteLines: createQuoteLineRepo(sql),
      checklist: createChecklistRepo(sql),
      settings: createSettingsRepo(sql),
      notificationLog: createNotificationLogRepo(sql),
      contacts: createContactRepo(sql),
      backup: createBackupRepo(sql),
      templates,
      extractLabels: createExtractLabelRepo(sql),
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
    this.pricingDefaults = withPricingDefaults(this.#parse(await this.#repos.settings.getRaw('pricing')));
    this.checklistTemplate = await this.#repos.templates.load();
    this.launchAtLogin = await this.#readLaunchAtLogin();
    await this.refreshNotifications();
    await this.loadNeedsSnoozes();
    this.ready = true;
    this.#timer = setInterval(() => (this.nowMs = Date.now()), 60_000);
  }

  get repos(): Repos {
    if (!this.#repos) throw new Error('Database not ready');
    return this.#repos;
  }

  async refresh() {
    const seq = ++this.#refreshSeq;
    const [b, c, l] = await Promise.allSettled([this.repos.bids.listAll(), this.repos.contacts.list(), this.repos.extractLabels.listLearned()]);
    if (seq !== this.#refreshSeq) return;
    if (b.status === 'fulfilled') this.bids = b.value;
    if (l.status === 'fulfilled') this.extractLabels = l.value;
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
      // A Needs-you notification snoozes its item (the list hides it too), not just this inbox row.
      const base = needsBaseKey(key);
      if (base) return await this.snoozeNeeds(base, until);
      await this.repos.notificationLog.snooze(key, until);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    await this.refreshNotifications();
  }

  async loadNeedsSnoozes() {
    try { this.needsSnoozes = await this.repos.notificationLog.needsSnoozes(); } catch (e) { this.#fail(e); }
  }

  /** Needs you → Snooze 1 day, or until `untilIso` (this device only). */
  async snoozeNeeds(key: string, untilIso?: string) {
    try {
      const now = Date.now();
      await this.repos.notificationLog.snoozeKey(key, untilIso ?? needsSnoozeUntil(now), new Date(now).toISOString());
    } catch (e) { this.#fail(e); }
    await this.loadNeedsSnoozes();
    await this.refreshNotifications();
  }

  /** Needs you → Claim (Team mode). */
  claim(bidId: string) {
    if (!this.meId) return Promise.resolve(false);
    return this.setOwner(bidId, this.meId);
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
    try { await this.repos.settings.setRaw('network_filters', JSON.stringify(storedFilters(f))); } catch (e) { this.#fail(e); }
  }

  /** Search box: filters immediately, never saved. */
  setNetworkSearch(search: string) {
    this.networkFilters = { ...this.networkFilters, search };
  }

  /** Clock, zone and follow-up thresholds for filters, sorting and the Status column. */
  filterCtx(): FilterCtx {
    return {
      nowMs: this.nowMs, zone: this.#zone(), followUp: this.followUp, team: this.team.mode === 'team', activeMemberIds: this.activeMemberIds,
    };
  }

  async savePricingDefaults(d: PricingDefaults): Promise<boolean> {
    try {
      const clean = withPricingDefaults(d);
      await this.repos.settings.setRaw('pricing', JSON.stringify(clean));
      this.pricingDefaults = clean;
      this.notice = { text: 'Default markup saved. Quotes and bids get it when you add their first line.' };
      return true;
    } catch (e) { this.#fail(e); return false; }
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
  /** Rows for this user's Needs you: mine, unowned, or owned by a deactivated teammate. */
  needsRowsSnapshot(): BidWithChildren[] {
    return this.bidsSnapshot().filter((d) => inNeedsList(d.bid, this.meId, this.activeMemberIds));
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
        if (on) await enableAutostart(); // rewrites it, so it points at this copy of the app
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
      this.reportRows = withOurPrice(await this.repos.contacts.reportRows(), this.quoteTotals());
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
      const rows = filterReportRows(withOurPrice(await this.repos.contacts.reportRows(), this.quoteTotals()), filters, now, zone);
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
        this.pricingDefaults = withPricingDefaults(this.#parse(await this.repos.settings.getRaw('pricing')));
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
    this.docImport = null;
  }

  #hiddenByFilters(id: string): boolean {
    const created = this.bids.find((d) => d.bid.id === id);
    return !!created && !applyNetworkFilters([created], this.networkFilters, this.meId, this.filterCtx()).length;
  }

  async createBid(input: NewBidInput): Promise<string | null> {
    const out = { id: '' };
    const ok = await this.#run(async () => { out.id = await this.repos.bids.create(input); });
    if (ok) {
      if (this.#hiddenByFilters(out.id)) this.notice = { text: 'Bid saved — hidden by your filters.' };
      this.open(out.id);
    }
    return ok ? out.id : null;
  }

  /** New RFQ; optionally link an existing contact or create one, as Procurement. A contact failure keeps the quote. */
  async createQuote(
    input: NewQuoteInput, contact: { existingId: string } | { input: ContactInput } | null = null,
  ): Promise<string | null> {
    const out = { id: '', contactError: '' };
    const ok = await this.#run(async () => {
      out.id = await this.repos.bids.createQuote(input);
      if (!contact) return;
      try {
        const contactId = 'existingId' in contact ? contact.existingId : (await this.repos.contacts.create(contact.input)).id;
        await this.repos.contacts.linkToBid(out.id, contactId, 'procurement');
      } catch (e) {
        out.contactError = e instanceof Error ? e.message : String(e);
      }
    });
    if (!ok) return null;
    if (out.contactError) this.error = `Quote saved, but the contact wasn’t added: ${out.contactError}`;
    if (this.#hiddenByFilters(out.id)) this.notice = { text: 'Quote saved — hidden by your filters.' };
    this.open(out.id);
    return out.id;
  }
  updateBid(id: string, patch: BidPatch) { return this.#run(() => this.repos.bids.update(id, patch)); }

  // Bid document import
  /** Read a dropped / picked document and open the New bid form with what it says (fills only blank inputs if already open). */
  async importDocument(path: string) {
    const name = baseName(path);
    if (!docKind(name)) { this.error = `${name}: only PDF, Word (.docx) and Excel (.xlsx) files can be imported.`; return; }
    try {
      if ((await fileSize(path)) > MAX_DOC_BYTES) { this.error = `${name} is larger than 50 MB.`; return; }
    } catch { this.error = `Couldn't open ${name}.`; return; }
    const seq = ++this.#docSeq;
    this.docImport = { seq, name, path, status: 'reading', lines: [], suggestions: null };
    this.quickAddOpen = true;
    let next: DocImport;
    try {
      const read = await readText(await readBytes(path), name, loadPdfjs);
      if (read.kind === 'no_text') next = { seq, name, path, status: 'no_text', lines: [], suggestions: null };
      else {
        const suggestions = extract(read.lines, $state.snapshot(this.extractLabels), DateTime.now().toISODate()!);
        next = { seq, name, path, status: isEmptySuggestions(suggestions) ? 'empty' : 'ready', lines: read.lines, suggestions };
      }
    } catch (e) {
      if (!(e instanceof ReadError)) console.warn('[import] reading failed', e);
      next = { seq, name, path, status: 'error', lines: [], suggestions: null, error: readErrorText(e) };
    }
    if (this.docImport?.seq === seq) this.docImport = next; // a newer drop wins
  }

  async importDocumentFromPicker() {
    try {
      const path = await pickDocument();
      if (!path) return;
      // Lets "Open file" open it later (a dropped file is registered by the app shell itself).
      await invoke('register_document', { path }).catch((e) => console.warn('[import] register', e));
      await this.importDocument(path);
    } catch (e) { this.#fail(e); }
  }

  /** Open the document being imported in its default app (only the last dropped/picked file is allowed). */
  async openImportedFile() {
    if (this.docImport) await invoke('open_document', { path: this.docImport.path }).catch((e) => this.#fail(e));
  }

  /** New bid from the document form: bid, extra details, offered milestones and the buyer contact in one write. */
  async createBidFromDocument(
    input: NewBidInput, details: BidPatch, stops: Omit<MilestoneInput, 'bidId'>[], contact: ContactInput | null,
  ): Promise<string | null> {
    const out = { id: '', contactError: '' };
    const ok = await this.#run(async () => {
      out.id = await this.repos.bids.create(input);
      if (Object.keys(details).length) await this.repos.bids.update(out.id, details);
      for (const s of stops) await this.repos.milestones.add({ ...s, bidId: out.id });
      if (!contact) return;
      try {
        const { id } = await this.repos.contacts.create(contact);
        await this.repos.contacts.linkToBid(out.id, id, 'procurement');
      } catch (e) {
        out.contactError = e instanceof Error ? e.message : String(e);
      }
    });
    if (!out.id) return null; // the bid itself wasn't written (#run showed why)
    // A later write failed: the bid exists, so open it (re-saving the form would duplicate it).
    if (!ok) this.error = `Bid saved, but not everything from the document was: ${this.error ?? 'unknown error'}`;
    else if (out.contactError) this.error = `Bid saved, but the contact wasn’t added: ${out.contactError}`;
    if (this.#hiddenByFilters(out.id)) this.notice = { text: 'Bid saved — hidden by your filters.' };
    this.open(out.id);
    return out.id;
  }

  /** After a save: learn new label phrases / count reused ones. Never blocks or fails the save. */
  async learnFromDocument(lines: Line[], events: LearnEvent[]) {
    if (!events.length) return;
    try {
      const today = DateTime.now().toISODate()!;
      const learned = $state.snapshot(this.extractLabels) as ExtractLabel[];
      await this.#exclusive(async () => {
        for (const ev of events) {
          if (ev.kind === 'scope_heading') {
            const known = learned.filter((l) => l.field === 'scope_heading').map((l) => l.phrase);
            const heading = learnScopeHeading(lines, ev.value, known, learned);
            if (heading) await this.repos.extractLabels.recordLabel('scope_heading', heading);
            continue;
          }
          const phrase = ev.kind === 'bump' ? ev.phrase : learnLabel(lines, ev.field, ev.value, knownLabels(ev.field, learned), today);
          if (phrase) await this.repos.extractLabels.recordLabel(ev.field, phrase);
        }
      });
      this.#team?.poke();
      this.extractLabels = await this.repos.extractLabels.listLearned();
    } catch (e) {
      console.warn('[import] learning failed', e);
    }
  }

  /** A team word for a scope tag (a new tag name makes a new tag); synced like learned phrases. */
  addScopeTagWord(tag: string, word: string) {
    const c = checkTagWord(tag, word);
    if ('error' in c) { this.error = c.error; return Promise.resolve(false); }
    return this.#run(() => this.repos.extractLabels.recordLabel(`${TAG_FIELD_PREFIX}${c.tag}`, c.word));
  }

  /** Soft delete (synced); the refresh after the write reloads the list. */
  removeExtractLabel(id: string) { return this.#run(() => this.repos.extractLabels.remove(id)); }
  async removeBid(id: string) { if (await this.#run(() => this.repos.bids.remove(id))) this.home(); }

  // Quotes (RFQs)
  markQuoteSent(id: string) { return this.#run(() => this.repos.bids.update(id, { stage: 'submitted', quotedAt: isoNow() })); }
  /** "Back to open" after marking sent by mistake: clears the quote time too. */
  unsendQuote(id: string) { return this.#run(() => this.repos.bids.update(id, { stage: 'reviewing', quotedAt: null })); }
  markFollowedUp(id: string) { return this.#run(() => this.repos.bids.update(id, { followedUpAt: isoNow() })); }
  setQuoteStage(id: string, stage: Stage) { return this.#run(() => this.repos.bids.update(id, { stage })); }
  async convertToBid(id: string, dueAtLocal: string, timezone: string): Promise<boolean> {
    let dueIso: string;
    try { dueIso = localToIso(dueAtLocal, timezone); } catch (e) { this.#fail(e); return false; }
    // One repo call: the timezone is written with the kind flip, after everything is validated.
    const ok = await this.#run(() => this.repos.bids.convertToBid(id, dueIso, timezone));
    if (ok) this.notice = { text: 'Converted to a bid. Add its other milestones below.' };
    return ok;
  }

  // Vendor requests (RFQs and bids)
  addVendor(bidId: string, input: NewVendorQuote) { return this.#run(() => this.repos.vendorQuotes.add(bidId, input)); }
  updateVendor(id: string, patch: { vendorName?: string; notes?: string | null }) { return this.#run(() => this.repos.vendorQuotes.update(id, patch)); }
  setVendorReplied(id: string, replied: boolean) { return this.#run(() => this.repos.vendorQuotes.setReplied(id, replied)); }
  setVendorSkipped(id: string, skipped: boolean) { return this.#run(() => this.repos.vendorQuotes.setSkipped(id, skipped)); }
  removeVendor(id: string) { return this.#run(() => this.repos.vendorQuotes.remove(id)); }
  /** Copy a follow-up message to the clipboard, then record the nudge (recorded even if the copy fails). */
  async nudgeVendor(bidId: string, vendorQuoteId: string): Promise<boolean> {
    const d = this.bids.find((x) => x.bid.id === bidId);
    const v = d?.vendorQuotes.find((x) => x.id === vendorQuoteId);
    if (!d || !v) return false;
    const contact = v.contactId ? this.contactList.find((c) => c.contact.id === v.contactId)?.contact : undefined;
    let copied = true;
    try {
      await navigator.clipboard.writeText(nudgeMessage(v, d.bid, this.#zone(), contact?.firstName ?? null));
    } catch {
      copied = false;
    }
    const ok = await this.#run(() => this.repos.vendorQuotes.nudge(vendorQuoteId));
    if (ok) {
      this.notice = {
        text: copied
          ? `Follow-up for ${v.vendorName} copied — paste it into your email.`
          : `Nudge recorded, but the message couldn’t be copied.`,
      };
    }
    return ok;
  }

  // Pricing (RFQs and bids)
  /** "Our price" (quote total) for every bid with priced lines — reports and export. */
  quoteTotals(): Map<string, number> {
    const m = new Map<string, number>();
    for (const d of this.bidsSnapshot()) {
      const t = quoteTotal(d, this.pricingDefaults);
      if (t !== null) m.set(d.bid.id, t);
    }
    return m;
  }
  /** After a bid's first line is added: pin the Settings markup on it, so every teammate prices it the same. */
  async #seedMarkup(bidId: string, lineCountBefore: number) {
    const d = this.bids.find((x) => x.bid.id === bidId);
    const patch = d ? seedMarkup(d.bid, lineCountBefore, this.pricingDefaults) : null;
    if (patch) await this.repos.bids.update(bidId, patch);
  }
  addLine(bidId: string, input: NewQuoteLine) {
    return this.#run(async () => {
      const before = this.bids.find((x) => x.bid.id === bidId)?.lines.length ?? 0;
      await this.repos.quoteLines.add(bidId, input); // validates first, so a bad add never pins the markup
      await this.#seedMarkup(bidId, before);
    });
  }
  updateLine(id: string, patch: QuoteLinePatch) { return this.#run(() => this.repos.quoteLines.update(id, patch)); }
  removeLine(id: string) { return this.#run(() => this.repos.quoteLines.remove(id)); }
  /** One vendor's unit cost for one line; null clears it. */
  setLinePrice(vendorQuoteId: string, lineId: string, unitCost: number | null) {
    return this.#run(() => this.repos.quoteLines.setPrice(vendorQuoteId, lineId, unitCost));
  }
  setPricingMode(bidId: string, pricingMode: PricingMode) { return this.#run(() => this.repos.bids.update(bidId, { pricingMode })); }
  setQuoteMarkup(bidId: string, m: Markup) {
    return this.#run(() => this.repos.bids.update(bidId, { markupType: m.type, markupValue: m.value }));
  }
  setSellRounding(bidId: string, sellRounding: number) { return this.#run(() => this.repos.bids.update(bidId, { sellRounding })); }
  /** Whole mode: buy everything from this vendor; null = pick automatically (lowest complete total, else most lines priced). */
  setWholeVendor(bidId: string, wholeVendorId: string | null) { return this.#run(() => this.repos.bids.update(bidId, { wholeVendorId })); }
  /**
   * Paste from Excel: add the rows as lines, then any vendor prices (columns matched to the grid's vendor order).
   * With no vendors, the one cost column fills each line's own cost.
   */
  async pasteLines(bidId: string, text: string): Promise<boolean> {
    let notice = '';
    // Everything reads state inside the queue, so a vendor removed by an earlier queued write is already gone.
    const ok = await this.#run(async () => {
      const d = this.bids.find((x) => x.bid.id === bidId);
      if (!d) throw new Error('Bid not found');
      const vendors = gridVendors(d.vendorQuotes);
      const parsed = parsePaste(text, vendors.length);
      if (!parsed.rows.length) throw new Error('Nothing to add. Paste rows with at least a Qty and a Description column.');
      const before = d.lines.length;
      // Every parsed row has a description, so addMany keeps them all and ids line up with rows.
      const ids = await this.repos.quoteLines.addMany(bidId,
        parsed.rows.map((r) => ({ qty: r.qty, description: r.description, partNo: r.partNo, unitCost: r.ownCost })));
      await this.#seedMarkup(bidId, before);
      let priced = parsed.rows.filter((r) => r.ownCost !== null).length;
      let skipped = 0;
      for (let i = 0; i < ids.length; i++) {
        for (let k = 0; k < vendors.length; k++) {
          const cost = parsed.rows[i].prices[k];
          if (cost === null) continue;
          try {
            await this.repos.quoteLines.setPrice(vendors[k].id, ids[i], cost);
            priced++;
          } catch {
            skipped++; // vendor gone since the grid loaded: keep the rest of the paste
          }
        }
      }
      notice = pasteNotice(parsed, priced) + (skipped ? ` ${skipped} price${skipped === 1 ? '' : 's'} skipped (vendor no longer on this request).` : '');
    });
    if (ok) this.notice = { text: notice };
    return ok;
  }

  addMilestone(input: NewMilestoneInput) { return this.#run(() => this.repos.milestones.add(input)); }
  updateMilestone(id: string, patch: MilestonePatch) { return this.#run(() => this.repos.milestones.update(id, patch)); }
  removeMilestone(id: string) { return this.#run(() => this.repos.milestones.remove(id)); }

  addChecklistItem(bidId: string, text: string) { return this.#run(() => this.repos.checklist.add(bidId, text)); }
  toggleChecklistItem(id: string, done: boolean) { return this.#run(() => this.repos.checklist.setDone(id, done)); }
  removeChecklistItem(id: string) { return this.#run(() => this.repos.checklist.remove(id)); }
  moveChecklistItem(id: string, dir: -1 | 1) { return this.#run(() => this.repos.checklist.move(id, dir)); }
}

export const app = new AppState();
