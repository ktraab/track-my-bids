<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { openTextFiles } from '$lib/files';
  import { detectFile, parseCsv, parseOutlookContacts, parseIcs, parseCalendarCsv, parseTasksCsv, type ImportItem, type ParseResult } from '$lib/domain/importParse';
  import { suggestGroups, buildImportPlan, type ImportGroup } from '$lib/domain/importClassify';
  import type { ContactInput } from '$lib/domain/contacts';
  import { MILESTONE_TYPE_LABELS, AGENCY_TYPE_LABELS, METHOD_LABELS } from '$lib/domain/labels';
  import { formatDateTime } from '$lib/domain/time';
  import type { MilestoneType } from '$lib/domain/types';

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  type FileRow = { path: string; name: string; kind: string; count: number; skipped: number };
  let files = $state<FileRow[]>([]);
  let contacts = $state<ContactInput[]>([]);
  let groups = $state<ImportGroup[]>([]);
  let parsed = $state.raw<ImportItem[]>([]);
  let showPast = $state(false);
  let busy = $state(false);
  let help = $state(false);
  let expanded = $state<Record<string, boolean>>({});
  const types = Object.entries(MILESTONE_TYPE_LABELS) as [MilestoneType, string][];
  const plan = $derived(buildImportPlan(groups, zone));
  const skippedGroups = $derived(groups.filter((g) => g.target.kind === 'skip').length);
  const KIND_LABEL: Record<string, string> = { ics: 'Calendar (.ics)', contacts_csv: 'Contacts', calendar_csv: 'Calendar (CSV)', tasks_csv: 'Tasks', unknown: 'Not recognized' };

  const hasDueRow = (g: ImportGroup) => g.rows.some((r) => r.type === 'due');
  const hasIncludedDue = (g: ImportGroup) => g.rows.some((r) => r.include && r.type === 'due');
  const withoutDue = (g: ImportGroup) => g.target.kind === 'new' && !hasIncludedDue(g) && !g.newBid.dueLocal.trim();

  async function pick() {
    let picked;
    try {
      picked = await openTextFiles([{ name: 'Outlook export', extensions: ['csv', 'ics'] }]);
    } catch (e) { app.error = String(e); return; }
    if (!picked.length) return;
    busy = true;
    try {
      const items: ImportItem[] = [];
      const seenUids = new Set<string>();
      const newContacts: ContactInput[] = [];
      const seen: FileRow[] = [];
      const addItems = (f: { path: string; name: string }, kind: string, r: ParseResult) => {
        let added = 0;
        for (const it of r.items) {
          if (seenUids.has(it.uid)) continue; // same event in two files: first wins
          seenUids.add(it.uid);
          items.push(it);
          added++;
        }
        seen.push({ path: f.path, name: f.name, kind, count: added, skipped: r.skipped });
      };
      for (const f of picked) {
        const kind = detectFile(f.name, f.text);
        try {
          if (kind === 'contacts_csv') { const c = parseOutlookContacts(parseCsv(f.text)); newContacts.push(...c); seen.push({ path: f.path, name: f.name, kind, count: c.length, skipped: 0 }); }
          else if (kind === 'ics') addItems(f, kind, parseIcs(f.text, Date.now(), zone));
          else if (kind === 'calendar_csv') addItems(f, kind, parseCalendarCsv(parseCsv(f.text), zone));
          else if (kind === 'tasks_csv') addItems(f, kind, parseTasksCsv(parseCsv(f.text), zone));
          else seen.push({ path: f.path, name: f.name, kind, count: 0, skipped: 0 });
        } catch (e) {
          seen.push({ path: f.path, name: f.name, kind: 'unknown', count: 0, skipped: 0 });
          app.error = `${f.name}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      files = seen;
      contacts = newContacts;
      parsed = items;
      expanded = {};
      groups = suggestGroups(items, app.bids, Date.now(), await app.importedUids());
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function importContactsNow() {
    busy = true;
    try {
      const res = await app.importContacts($state.snapshot(contacts) as ContactInput[]);
      if (res) contacts = [];
    } finally {
      busy = false;
    }
  }

  async function importEventsNow() {
    if (plan.errors.length) return;
    busy = true;
    try {
      const res = await app.runImport($state.snapshot(plan) as typeof plan);
      if (res) groups = suggestGroups(parsed, app.bids, Date.now(), await app.importedUids());
    } finally {
      busy = false;
    }
  }

  function skipAllWithoutDue() {
    for (const g of groups) if (withoutDue(g)) g.target = { kind: 'skip' };
  }

  const visibleRows = (g: ImportGroup) => g.rows.filter((r) => showPast || r.include || r.item.startMs >= Date.now() - 30 * 86_400_000);
</script>

{#snippet targetSelect(g: ImportGroup, gi: number)}
  <select aria-label="Target for {g.label}" value={g.target.kind === 'existing' ? g.target.bidId : g.target.kind}
    onchange={(e) => {
      const v = e.currentTarget.value;
      const wasSkipped = groups[gi].target.kind === 'skip';
      groups[gi].target = v === 'new' || v === 'skip' ? { kind: v } : { kind: 'existing', bidId: v };
      // Turning a skipped group back on: check its recent events so they come along.
      if (wasSkipped && v !== 'skip') {
        const cutoff = Date.now() - 30 * 86_400_000;
        for (const r of groups[gi].rows) if (r.item.startMs >= cutoff) r.include = true;
      }
    }}>
    <option value="new">New bid</option>
    <option value="skip">Skip</option>
    <optgroup label="Add to existing bid">
      {#each app.bids.filter((d) => d.bid.kind !== 'rfq') as d (d.bid.id)}<option value={d.bid.id}>{d.bid.agencyName} · {d.bid.title}</option>{/each}
    </optgroup>
  </select>
{/snippet}

<section class="page">
  <div class="topbar">
    <button class="btn" onclick={() => app.showContacts()}>‹ Contacts</button>
    <h1>Import from Outlook</h1>
    <div class="spacer"></div>
    <button class="btn" onclick={() => (help = !help)} aria-expanded={help}>How do I export from Outlook?</button>
    <button class="btn primary" onclick={pick}>Choose files…</button>
  </div>

  {#if help}
    <div class="card box help">
      <h2>Exporting from Outlook</h2>
      <h3>New Outlook / Outlook on the web</h3>
      <ul>
        <li><b>Contacts:</b> People → Manage contacts → Export contacts → CSV.</li>
        <li><b>Calendar:</b> Settings → Calendar → Shared calendars → Publish a calendar → choose your calendar, "Can view all details" → Publish. Open the <b>ICS</b> link in your browser to download the file. Unpublish the calendar afterwards (Settings → Calendar → Shared calendars) so the link stops working. (If publishing is turned off, ask IT or export each bid meeting: open the event → ··· → Download/Save as .ics.)</li>
        <li><b>To Do tasks:</b> not exportable yet — coming with "Connect Microsoft 365".</li>
      </ul>
      <h3>Classic Outlook (Windows)</h3>
      <ul>
        <li><b>Contacts / Calendar / Tasks:</b> File → Open &amp; Export → Import/Export → Export to a file → Comma Separated Values → pick the folder → set the date range.</li>
        <li><b>Calendar as .ics:</b> Calendar → File → Save Calendar → More Options → Date range / Full details.</li>
      </ul>
      <h3>Legacy Outlook for Mac</h3>
      <ul><li>In legacy Outlook for Mac, drag events from the calendar to your desktop (each becomes an .ics), then choose them here. New Outlook for Mac: use the "New Outlook" steps above.</li></ul>
    </div>
  {/if}

  {#if files.length}
    <div class="card box">
      <h2>Files</h2>
      <ul class="files">{#each files as f (f.path)}<li>{f.name} — {KIND_LABEL[f.kind]}{f.count ? ` · ${f.count} item${f.count === 1 ? '' : 's'}` : ''}{#if f.skipped}<span class="warn-text"> · {f.skipped} couldn't be read and were skipped</span>{/if}</li>{/each}</ul>
    </div>
  {:else}
    <p class="hint">Choose one or more Outlook export files (.csv or .ics). Nothing is saved until you click Import.</p>
  {/if}

  {#if contacts.length}
    <div class="card box">
      <h2>Contacts ({contacts.length})</h2>
      <p class="hint">People who already exist (same email, or same name and organization) are matched, not duplicated.</p>
      <button class="btn primary" disabled={busy} onclick={importContactsNow}>Import {contacts.length} contacts</button>
    </div>
  {/if}

  {#if groups.length}
    <div class="card box">
      <div class="head">
        <h2>Calendar &amp; tasks → bids</h2>
        <label class="check"><input type="checkbox" bind:checked={showPast} /> Show events older than 30 days</label>
      </div>
      <p class="hint">Check the type of each event and which bid it belongs to. New bids need a due date: mark one event as "Due date" or type it in.</p>
      <div class="bulk">
        <button class="btn" onclick={skipAllWithoutDue} disabled={!groups.some(withoutDue)}>Skip all groups without a due date</button>
        <span class="hint">{skippedGroups} of {groups.length} group{groups.length === 1 ? '' : 's'} skipped</span>
      </div>
      {#each groups as g, gi (g.key)}
        {#if g.target.kind === 'skip' && !expanded[g.key]}
          <div class="group collapsed">
            <strong>{g.label}</strong>
            {@render targetSelect(g, gi)}
            <span class="hint">{hasDueRow(g) ? 'Skipped.' : 'Skipped — no due date. Set target to New bid to include.'} {g.rows.length} event{g.rows.length === 1 ? '' : 's'}</span>
            <div class="spacer"></div>
            <button class="linkish" aria-expanded="false" onclick={() => (expanded[g.key] = true)}>Show</button>
          </div>
        {:else}
        <fieldset class="group">
          <legend>
            <strong>{g.label}</strong>
            {@render targetSelect(g, gi)}
            {#if g.target.kind === 'skip'}
              <span class="hint">{hasDueRow(g) ? 'Skipped.' : 'Skipped — no due date. Set target to New bid to include.'}</span>
              <button class="linkish" aria-expanded="true" onclick={() => (expanded[g.key] = false)}>Hide</button>
            {/if}
          </legend>
          {#if g.target.kind === 'new'}
            <div class="grid4">
              <label class="field"><span>Bid title</span><input bind:value={groups[gi].newBid.title} /></label>
              <label class="field"><span>Agency</span><input bind:value={groups[gi].newBid.agencyName} /></label>
              <label class="field"><span>Agency type</span>
                <select bind:value={groups[gi].newBid.agencyType}>{#each Object.entries(AGENCY_TYPE_LABELS) as [v, l] (v)}<option value={v}>{l}</option>{/each}</select>
              </label>
              <label class="field"><span>Submission</span>
                <select bind:value={groups[gi].newBid.method}>{#each Object.entries(METHOD_LABELS) as [v, l] (v)}<option value={v}>{l}</option>{/each}</select>
              </label>
            </div>
            {#if !hasIncludedDue(g)}
              <div class="manual-due">
                <label class="field"><span>Due date &amp; time</span><input type="datetime-local" bind:value={groups[gi].newBid.dueLocal} /></label>
                <span class="hint">Not in your calendar? Enter it here — or change an event's Type to Due date.</span>
              </div>
            {/if}
          {/if}
          <table>
            <thead><tr><th><span class="sr">Include</span></th><th>When</th><th>Event</th><th>Type</th><th>Mandatory</th></tr></thead>
            <tbody>
              {#each visibleRows(g) as r (r.item.uid)}
                {@const ri = g.rows.indexOf(r)}
                <tr class:off={!r.include}>
                  <td><input type="checkbox" aria-label="Include {r.item.title}" bind:checked={groups[gi].rows[ri].include} /></td>
                  <td class="when">{formatDateTime(new Date(r.item.startMs).toISOString(), zone)}{#if r.item.allDay}<span class="tag-soft">time not set</span>{/if}</td>
                  <td>{r.item.title}{#if r.item.location}<div class="hint">{r.item.location}</div>{/if}{#if g.target.kind === 'existing' && r.type === 'due'}<div class="hint warn-text">Due date already set on this bid — change it on the bid instead.</div>{/if}</td>
                  <td><select aria-label="Type for {r.item.title}" bind:value={groups[gi].rows[ri].type}>{#each types as [v, l] (v)}<option value={v}>{l}</option>{/each}</select></td>
                  <td><input type="checkbox" aria-label="Mandatory: {r.item.title}" bind:checked={groups[gi].rows[ri].mandatory} /></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </fieldset>
        {/if}
      {/each}
      {#if plan.errors.length}
        <ul class="errors" role="alert">{#each plan.errors as e (e)}<li>{e}</li>{/each}</ul>
      {/if}
      <div class="actions">
        <span class="hint">{plan.newBids.length} new bid{plan.newBids.length === 1 ? '' : 's'} · {plan.newBids.reduce((n, b) => n + b.milestones.length + 1, 0) + plan.existing.reduce((n, x) => n + x.milestones.length, 0)} milestones</span>
        {#if !plan.errors.length && !plan.newBids.length && !plan.existing.length}
          <span class="hint">Nothing selected yet: set a group's target to New bid or an existing bid.</span>
        {/if}
        <button class="btn primary" disabled={busy || plan.errors.length > 0 || (!plan.newBids.length && !plan.existing.length)} onclick={importEventsNow}>Import</button>
      </div>
    </div>
  {:else if files.length && !contacts.length}
    <p class="hint">No new events to import (events already imported are skipped).</p>
  {/if}
</section>

<style>
  .topbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .topbar h1 { font-size: 28px; }
  .spacer { flex: 1; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .help h3 { margin: 10px 0 4px; font-size: 14px; }
  .help ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
  .files { margin: 0; padding-left: 18px; }
  .group { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin: 0; display: flex; flex-direction: column; gap: 10px; }
  legend { display: flex; gap: 10px; align-items: center; padding: 0 6px; }
  legend select, .collapsed select, td select { height: 32px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
  .grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  @media (max-width: 1000px) { .grid4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  tr.off td { color: var(--muted); }
  .when { white-space: nowrap; }
  .tag-soft { margin-left: 6px; font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #fff7e6; color: #7a4b00; }
  .errors { margin: 0; padding: 10px 14px 10px 28px; border-radius: 10px; background: #fff4f2; color: var(--red); }
  .bulk { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .group.collapsed { flex-direction: row; align-items: center; gap: 10px; padding: 8px 14px; }
  .manual-due { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
  .manual-due .field { width: 240px; }
  .warn-text { color: #7a4b00; }
  .actions { display: flex; justify-content: flex-end; align-items: center; gap: 12px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
