<script lang="ts">
  import { untrack } from 'svelte';
  import { getVersion } from '@tauri-apps/api/app';
  import { appDataDir } from '@tauri-apps/api/path';
  import { app } from '$lib/state.svelte';
  import TeamSettings from './TeamSettings.svelte';
  import PricingSettings from './PricingSettings.svelte';
  import DocImportSettings from './DocImportSettings.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import { MILESTONE_TYPE_LABELS } from '$lib/domain/labels';
  import { MAX_STALE_DAYS, NEEDS_LIMITS, validateSettingsDraft, type NotificationSettings } from '$lib/domain/settings';
  import type { MilestoneType } from '$lib/domain/types';
  import { hasTemplateItem, type TemplateItem } from '$lib/domain/checklist';
  import { reveal } from '$lib/files';
  import OffsetEditor from './OffsetEditor.svelte';
  import { updater } from '$lib/update';

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const TYPES = Object.keys(MILESTONE_TYPE_LABELS) as MilestoneType[];
  const GROUPS: [TemplateItem['appliesTo'], string][] = [['all', 'Every bid'], ['sealed', 'Sealed bids'], ['online', 'Online bids'], ['email', 'Email bids']];

  let s = $state<NotificationSettings>(untrack(() => structuredClone($state.snapshot(app.notificationSettings))));
  let tpl = $state<TemplateItem[]>(untrack(() => structuredClone($state.snapshot(app.checklistTemplate))));
  let newItem = $state<Record<string, string>>({ all: '', sealed: '', online: '', email: '' });
  let dupError = $state<Record<string, string>>({});
  let confirmingReset = $state(false);
  let version = $state('');
  let saving = $state(false);

  const dirtyNotif = $derived(JSON.stringify(s) !== JSON.stringify(app.notificationSettings));
  const dirtyTpl = $derived(JSON.stringify(tpl) !== JSON.stringify(app.checklistTemplate));
  const errors = $derived(validateSettingsDraft(s));

  // Accordion: all sections start collapsed; opening one closes the others.
  let openSection = $state<string | null>(null);
  function toggle(id: string) { openSection = openSection === id ? null : id; }
  function clock(hhmm: string): string {
    const [h, m] = hhmm.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
  const notifSummary = $derived(
    !app.notificationSettings.enabled ? 'Off'
      : app.notificationSettings.digestTimes.length ? `On · briefing ${app.notificationSettings.digestTimes.map(clock).join(', ')}`
      : 'On · no briefing',
  );
  const pricingSummary = $derived.by(() => {
    const { markupType, markupValue } = app.pricingDefaults;
    if (markupType === 'pct') return `${markupValue}% default markup`;
    return `$${markupValue} per ${markupType === 'unit' ? 'unit' : 'line'} default markup`;
  });
  const teamSummary = $derived(app.team.mode === 'team' ? 'Team mode · shared with your team' : 'Local · this computer only');
  const invalid = $derived(Object.keys(errors).length > 0);

  $effect(() => { getVersion().then((v) => (version = v)).catch(() => {}); });

  const toggleDay = (d: number) => (s.digestDays = s.digestDays.includes(d) ? s.digestDays.filter((x) => x !== d) : [...s.digestDays, d].sort());

  async function saveNotif() {
    if (invalid) return;
    saving = true;
    if (await app.saveNotificationSettings($state.snapshot(s) as NotificationSettings)) {
      s = structuredClone($state.snapshot(app.notificationSettings));
    }
    saving = false;
  }

  function addTpl(group: TemplateItem['appliesTo']) {
    const text = newItem[group].trim();
    if (!text) return;
    if (hasTemplateItem(tpl, group, text)) {
      dupError[group] = `"${text}" is already in this list.`;
      return;
    }
    dupError[group] = '';
    tpl = [...tpl, { text, appliesTo: group }];
    newItem[group] = '';
  }
  function moveTpl(item: TemplateItem, dir: -1 | 1) {
    const same = tpl.filter((x) => x.appliesTo === item.appliesTo);
    const i = same.indexOf(item);
    const j = i + dir;
    if (j < 0 || j >= same.length) return;
    const a = tpl.indexOf(same[i]);
    const b = tpl.indexOf(same[j]);
    const next = [...tpl];
    [next[a], next[b]] = [next[b], next[a]];
    tpl = next;
  }
  async function saveTpl() {
    if (await app.saveChecklistTemplate($state.snapshot(tpl) as TemplateItem[])) tpl = structuredClone($state.snapshot(app.checklistTemplate));
  }
  async function resetTpl() {
    confirmingReset = false;
    await app.resetChecklistTemplate();
    tpl = structuredClone($state.snapshot(app.checklistTemplate));
  }
  async function showData() {
    try { await reveal(await appDataDir()); } catch (e) { app.error = String(e); }
  }
</script>

<section class="page">
  <div class="topbar">
    <button class="btn" onclick={() => app.home()}>‹ Network</button>
    <h1>Settings</h1>
  </div>

  <SettingsSection id="notifications" title="Notifications" summary={notifSummary} badge={dirtyNotif ? 'Unsaved' : ''} open={openSection === 'notifications'} ontoggle={toggle}>
    <label class="check"><input type="checkbox" bind:checked={s.enabled} /> Notifications on</label>

    <div class="grid2">
      <fieldset>
        <legend>Morning briefing times</legend>
        {#each s.digestTimes as _, i (i)}
          <div class="inline">
            <input type="time" bind:value={s.digestTimes[i]} aria-label="Briefing time {i + 1}" />
            <button type="button" class="icon" aria-label="Remove briefing time {i + 1}" onclick={() => (s.digestTimes = s.digestTimes.filter((_, k) => k !== i))}>✕</button>
          </div>
        {:else}
          <p class="hint">No briefing. Reminders still arrive.</p>
        {/each}
        {#if errors.digestTimes}<p class="err" role="alert">{errors.digestTimes}</p>{/if}
        <button type="button" class="btn small" onclick={() => (s.digestTimes = [...s.digestTimes, '13:00'])}>+ Add time</button>
      </fieldset>
      <fieldset>
        <legend>Briefing days</legend>
        <div class="days">
          {#each DAYS as d, i (d)}
            <label class="chip"><input type="checkbox" checked={s.digestDays.includes(i + 1)} onchange={() => toggleDay(i + 1)} /> {d}</label>
          {/each}
        </div>
        {#if !s.digestDays.length}<p class="hint">No briefing will be sent.</p>{/if}
        <legend class="sub">Quiet hours (nothing pops up unless it can't wait)</legend>
        <div class="inline">
          <label class="field"><span>From</span><input type="time" bind:value={s.quietStart} /></label>
          <label class="field"><span>To</span><input type="time" bind:value={s.quietEnd} /></label>
        </div>
        {#if errors.quiet}<p class="err" role="alert">{errors.quiet}</p>{/if}
        <p class="hint">Set From and To to the same time to turn quiet hours off.</p>
      </fieldset>
    </div>

    <h3>Reminder timing</h3>
    <p class="hint">Default reminders for each kind of milestone. You can still override a single milestone.</p>
    {#each TYPES as t (t)}
      <OffsetEditor label={MILESTONE_TYPE_LABELS[t]} bind:offsets={s.reminderDefaults[t]} />
    {/each}
    <OffsetEditor label="Ship by (sealed)" bind:offsets={s.shipByOffsets} />

    <div class="inline">
      <label class="field"><span>Nudge me about a bid untouched for (days)</span>
        <input type="number" min="1" max={MAX_STALE_DAYS} step="1" bind:value={s.staleDays} aria-invalid={!!errors.staleDays} />
      </label>
    </div>
    {#if errors.staleDays}<p class="err" role="alert">{errors.staleDays}</p>{/if}

    <h3>Needs you</h3>
    <p class="hint">When something lands in the hand-icon list (you get one notification, held during quiet hours).</p>
    <div class="inline">
      <label class="field"><span>Vendor quiet after (business days)</span>
        <input type="number" min="1" max={NEEDS_LIMITS.vendorQuietBusinessDays} step="1" bind:value={s.vendorQuietBusinessDays} aria-invalid={!!errors.needs?.vendorQuietBusinessDays} />
      </label>
      <label class="field"><span>Customer follow-up after (business days)</span>
        <input type="number" min="1" max={NEEDS_LIMITS.customerBusinessDays} step="1" bind:value={s.customerBusinessDays} aria-invalid={!!errors.needs?.customerBusinessDays} />
      </label>
      <label class="field"><span>New RFQ unclaimed after (work hours, Team mode)</span>
        <input type="number" min="1" max={NEEDS_LIMITS.unclaimedWorkHours} step="1" bind:value={s.unclaimedWorkHours} aria-invalid={!!errors.needs?.unclaimedWorkHours} />
      </label>
      <label class="field"><span>Mandatory bid stop within (hours)</span>
        <input type="number" min="1" max={NEEDS_LIMITS.stopWithinHours} step="1" bind:value={s.stopWithinHours} aria-invalid={!!errors.needs?.stopWithinHours} />
      </label>
    </div>
    <div class="inline">
      <label class="field"><span>Default next step after logging a touch (business days)</span>
        <input type="number" min="1" max={NEEDS_LIMITS.nextDefaultBusinessDays} step="1" bind:value={s.nextDefaultBusinessDays} aria-invalid={!!errors.needs?.nextDefaultBusinessDays} />
      </label>
    </div>
    {#each Object.entries(errors.needs ?? {}) as [k, msg] (k)}<p class="err" role="alert">{msg}</p>{/each}
    <p class="hint">Business days skip weekends and US holidays. Work hours are 8 AM–5 PM, Monday to Friday.</p>

    <div class="actions">
      {#if dirtyNotif}<span class="hint">Unsaved changes</span>{/if}
      <button class="btn" disabled={!dirtyNotif} onclick={() => (s = structuredClone($state.snapshot(app.notificationSettings)))}>Discard</button>
      {#if invalid}<span class="err">Fix the errors above to save.</span>{/if}
      <button class="btn primary" disabled={!dirtyNotif || saving || invalid} onclick={saveNotif}>Save notification settings</button>
    </div>
  </SettingsSection>

  <SettingsSection id="checklist" title="Checklist template" summary="{tpl.length} item{tpl.length === 1 ? '' : 's'}" badge={dirtyTpl ? 'Unsaved' : ''} open={openSection === 'checklist'} ontoggle={toggle}>
    <p class="hint">New bids start with these items. Existing bids are not changed.</p>
    <div class="grid2">
      {#each GROUPS as [g, label] (g)}
        <fieldset>
          <legend>{label}</legend>
          <ul>
            {#each tpl.filter((x) => x.appliesTo === g) as item (item)}
              <li>
                <span>{item.text}</span>
                <span class="tools">
                  <button type="button" class="icon" aria-label="Move {item.text} up" onclick={() => moveTpl(item, -1)}>↑</button>
                  <button type="button" class="icon" aria-label="Move {item.text} down" onclick={() => moveTpl(item, 1)}>↓</button>
                  <button type="button" class="icon" aria-label="Remove {item.text}" onclick={() => (tpl = tpl.filter((x) => x !== item))}>✕</button>
                </span>
              </li>
            {/each}
          </ul>
          <form class="add" onsubmit={(e) => { e.preventDefault(); addTpl(g); }}>
            <input bind:value={newItem[g]} oninput={() => (dupError[g] = '')} maxlength="200" placeholder="Add item" aria-label="Add item to {label}" />
            <button class="btn small" type="submit">Add</button>
          </form>
          {#if dupError[g]}<p class="err" role="alert">{dupError[g]}</p>{/if}
        </fieldset>
      {/each}
    </div>
    <div class="actions">
      {#if confirmingReset}
        <span class="hint">Replace your template with the built-in default?</span>
        <button class="btn" onclick={() => (confirmingReset = false)}>Keep</button>
        <button class="btn danger" onclick={resetTpl}>Confirm reset</button>
      {:else}
        <button class="btn" onclick={() => (confirmingReset = true)}>Reset to default</button>
      {/if}
      <button class="btn primary" disabled={!dirtyTpl} onclick={saveTpl}>Save template</button>
    </div>
  </SettingsSection>

  <SettingsSection id="pricing" title="Pricing" summary={pricingSummary} open={openSection === 'pricing'} ontoggle={toggle}>
    <PricingSettings />
  </SettingsSection>

  <SettingsSection id="docimport" title="Document import" summary="{app.extractLabels.length} learned phrase{app.extractLabels.length === 1 ? '' : 's'}" open={openSection === 'docimport'} ontoggle={toggle}>
    <DocImportSettings />
  </SettingsSection>

  <SettingsSection id="team" title="Team" summary={teamSummary} open={openSection === 'team'} ontoggle={toggle}>
    <TeamSettings />
  </SettingsSection>

  <SettingsSection id="general" title="General" summary={version ? `Launch at login, updates · version ${version}` : 'Launch at login, updates'} open={openSection === 'general'} ontoggle={toggle}>
    <label class="check"><input type="checkbox" checked={app.launchAtLogin} onchange={async (e) => { const box = e.currentTarget; if (!(await app.setLaunchAtLogin(box.checked))) box.checked = app.launchAtLogin; }} /> Open TrackMyBids when I log in (needed for morning briefings)</label>
    <p class="hint">Closing the window keeps reminders running in the menu bar / system tray. Quit from the tray icon to stop them.</p>
    <div class="inline">
      <button class="btn" onclick={showData}>Show data folder</button>
      <span class="hint">Version {version || '—'}</span>
    </div>
    <div class="inline">
      <button class="btn" disabled={updater.busy} onclick={() => updater.checkNow()}>{updater.status === 'checking' ? 'Checking…' : 'Check for updates'}</button>
      {#if updater.status === 'current'}<span class="hint">You have the latest version.</span>
      {:else if updater.status === 'available' && !updater.error}<span class="hint">Version {updater.version} is available.</span><button class="btn primary" onclick={() => updater.install()}>Update &amp; restart</button>
      {:else if updater.error}<span class="err">{updater.error}</span>{/if}
    </div>
    <p class="hint">TrackMyBids checks for updates every few hours and asks before installing.</p>
  </SettingsSection>
</section>

<style>
  .topbar { display: flex; align-items: center; gap: 12px; }
  .topbar h1 { font-size: 28px; }
  h3 { margin: 8px 0 0; font-size: 15px; }
  fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  legend { font-size: 12px; font-weight: 600; color: var(--muted); padding: 0; margin-bottom: 4px; }
  legend.sub { margin-top: 10px; }
  .inline { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  input[type='time'] { height: 36px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; }
  .days { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 16px; font-size: 13px; }
  .actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
  .btn.small { height: 32px; padding: 0 12px; font-size: 13px; align-self: flex-start; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; border-top: 1px solid var(--line-soft); }
  li .tools { display: flex; gap: 2px; }
  .err { margin: 0; color: var(--red); font-size: 13px; }
</style>
