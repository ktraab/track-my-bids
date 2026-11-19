<script lang="ts">
  import { DateTime } from 'luxon';
  import { app } from '$lib/state.svelte';
  import { AGENCY_TYPE_LABELS, timezoneOptions } from '$lib/domain/labels';
  import { RFQ_STAGE_LABELS, isClosed } from '$lib/domain/stages';
  import {
    ballOf, ballText, customerFollowUpAt, historyEvents, isOverdue, nextStepText, receivedIso, relDay,
  } from '$lib/domain/rfq';
  import { lineLetter } from '$lib/domain/palette';
  import { formatDateTime, isoToLocalInput, localToIso } from '$lib/domain/time';
  import { initials } from '$lib/domain/ownership';
  import type { AgencyType } from '$lib/domain/types';
  import VendorsSection from './VendorsSection.svelte';
  import PricingSection from './PricingSection.svelte';
  import Checklist from './Checklist.svelte';
  import ContactsSection from './ContactsSection.svelte';

  let { id }: { id: string } = $props();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let editing = $state(false);
  let confirmDelete = $state(false);
  let converting = $state(false);
  let dueLocal = $state('');
  let dueTz = $state(zone);
  let notes = $state<string | null>(null); // null = not editing
  let f = $state({ title: '', agencyName: '', agencyType: 'other' as AgencyType, receivedLocal: '' });

  const data = $derived(app.bids.find((d) => d.bid.id === id));
  const ball = $derived(data ? ballOf(data.bid, data.vendorQuotes) : null);
  const overdue = $derived(data ? isOverdue(data, app.nowMs, zone, app.followUp) : false);
  const history = $derived(data ? historyEvents(data.bid, data.vendorQuotes, zone) : []);
  /** Team mode names who holds an "on us" quote. */
  const usWho = $derived(
    data && app.team.mode === 'team' ? (data.bid.ownerId ? initials(app.memberName(data.bid.ownerId)) : 'unassigned') : null);
  const HIST_COLOR: Record<string, string> = {
    in: 'var(--us)', asked: 'var(--vendor)', reply: 'var(--vendor)', skip: 'var(--past)', nudge: 'var(--red)',
    sent: 'var(--cust)', followup: 'var(--cust)',
  };

  function safeLocal(iso: string): string {
    try { return isoToLocalInput(iso, zone); } catch { return ''; }
  }
  const when = (iso: string) => DateTime.fromISO(iso).setZone(zone).toFormat('ccc LLL d, h:mm a');

  function startEdit() {
    if (!data) return;
    const b = data.bid;
    f = { title: b.title, agencyName: b.agencyName, agencyType: b.agencyType, receivedLocal: safeLocal(receivedIso(b)) };
    editing = true;
  }

  async function saveEdit(e: SubmitEvent) {
    e.preventDefault();
    if (!f.title.trim() || !f.agencyName.trim() || !f.receivedLocal) return;
    let receivedAt: string;
    try { receivedAt = localToIso(f.receivedLocal, zone); } catch { app.error = 'The received time looks wrong.'; return; }
    const ok = await app.updateBid(id, { title: f.title.trim(), agencyName: f.agencyName.trim(), agencyType: f.agencyType, receivedAt });
    if (ok) editing = false;
  }

  function startConvert() {
    dueLocal = '';
    dueTz = data?.bid.timezone ?? zone;
    converting = true;
  }

  async function convert(e: SubmitEvent) {
    e.preventDefault();
    if (!dueLocal) return;
    if (await app.convertToBid(id, dueLocal, dueTz)) converting = false;
  }

  async function saveNotes() {
    if (notes === null) return;
    if (await app.updateBid(id, { notes: notes.trim() || null })) notes = null;
  }
</script>

{#if !data}
  <section class="page">
    <button class="btn" onclick={() => app.home()}>‹ Network</button>
    <p>This quote no longer exists.</p>
  </section>
{:else}
  {@const b = data.bid}
  <section class="page">
    <div class="topbar">
      <button class="btn" onclick={() => app.home()}>‹ Network</button>
      <div class="spacer"></div>
      <button class="btn" onclick={() => (editing ? (editing = false) : startEdit())}>{editing ? 'Close editor' : 'Edit details'}</button>
      {#if app.canManage(b)}
        {#if confirmDelete}
          <button class="btn danger" onclick={() => app.removeBid(b.id)}>Confirm delete</button>
          <button class="btn" onclick={() => (confirmDelete = false)}>Keep</button>
        {:else}
          <button class="btn danger" onclick={() => (confirmDelete = true)}>Delete</button>
        {/if}
      {/if}
    </div>

    <header class="head">
      <span class="badge qbadge">{lineLetter(b.agencyName)}</span>
      <div class="titles">
        <div class="eyebrow">Quote · {AGENCY_TYPE_LABELS[b.agencyType]} · received {formatDateTime(receivedIso(b), zone)}</div>
        <h1>{b.title}</h1>
        <div class="sub">{b.agencyName}
          {#if app.team.mode === 'team'}
            · Owner
            {#if app.canManage(b)}
              {@const owners = app.team.members.filter((m) => m.active && m.role !== 'pending')}
              <select class="owner-pick" aria-label="Owner" value={b.ownerId ?? ''} onchange={async (e) => { const el = e.currentTarget; if (!(await app.setOwner(b.id, el.value))) el.value = b.ownerId ?? ''; }}>
                {#if !owners.some((m) => m.id === b.ownerId)}<option value={b.ownerId ?? ''} disabled>{b.ownerId ? app.memberName(b.ownerId) : 'Unassigned'}</option>{/if}
                {#each owners as m (m.id)}<option value={m.id}>{m.displayName || m.email}</option>{/each}
              </select>
            {:else}
              <strong>{b.ownerId ? app.memberName(b.ownerId) : 'Unassigned'}</strong>
            {/if}
          {/if}
        </div>
      </div>
      <div class="state">
        {#if ball}
          <span class="ball {ball.holder}" class:late={overdue}>{ballText(ball, app.nowMs, ball.holder === 'us' ? usWho : ball.who)}</span>
        {/if}
        <span class="stage">{RFQ_STAGE_LABELS[b.stage]}</span>
        <span class="hint" class:late-text={overdue}>{nextStepText(data, app.nowMs, zone, app.followUp)}</span>
      </div>
    </header>

    {#if editing}
      <form class="card box" onsubmit={saveEdit}>
        <h2>Edit details</h2>
        <div class="grid2">
          <label class="field"><span>Customer *</span><input bind:value={f.agencyName} required /></label>
          <label class="field"><span>What they want *</span><input bind:value={f.title} required /></label>
        </div>
        <div class="grid2">
          <label class="field"><span>Agency type</span>
            <select bind:value={f.agencyType}>
              {#each Object.entries(AGENCY_TYPE_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
            </select>
          </label>
          <label class="field"><span>Received</span><input type="datetime-local" bind:value={f.receivedLocal} required /></label>
        </div>
        <div class="row end">
          <button type="button" class="btn" onclick={() => (editing = false)}>Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    {/if}

    <section class="card box" aria-label="Quote actions">
      {#if isClosed(b.stage)}
        <p class="closed">Closed as <strong>{RFQ_STAGE_LABELS[b.stage]}</strong>{b.quotedAt ? ` · quote sent ${formatDateTime(b.quotedAt, zone)}` : ''}.</p>
        <div class="row">
          <button class="btn" onclick={() => app.setQuoteStage(b.id, b.quotedAt ? 'submitted' : 'reviewing')}>Reopen</button>
        </div>
      {:else}
        <div class="row">
          {#if b.stage === 'submitted'}
            <button class="btn primary" onclick={() => app.markFollowedUp(b.id)}>Followed up</button>
            <button class="btn" onclick={() => app.unsendQuote(b.id)}>Back to open</button>
          {:else}
            <button class="btn primary" onclick={() => app.markQuoteSent(b.id)}>Mark quote sent →</button>
          {/if}
          <span class="sep" aria-hidden="true"></span>
          <button class="btn" onclick={() => app.setQuoteStage(b.id, 'awarded')}>Won</button>
          <button class="btn" onclick={() => app.setQuoteStage(b.id, 'lost')}>Lost</button>
          <button class="btn" onclick={() => app.setQuoteStage(b.id, 'no_bid')}>No reply</button>
          {#if b.stage === 'reviewing'}
            <span class="spacer"></span>
            <button class="btn" onclick={startConvert} disabled={converting}>Convert to bid</button>
          {/if}
        </div>
        {#if b.stage === 'submitted'}
          <p class="hint">
            Quote sent {formatDateTime(b.quotedAt ?? b.updatedAt, zone)}{b.followedUpAt ? ` · last follow-up ${formatDateTime(b.followedUpAt, zone)}` : ''}
            · next follow-up {relDay(customerFollowUpAt(b, zone, app.followUp), app.nowMs, zone)}.
          </p>
        {/if}
        {#if converting && b.stage === 'reviewing'}
          <form class="convert" onsubmit={convert}>
            <label class="field"><span>Due date &amp; time *</span><input type="datetime-local" bind:value={dueLocal} required /></label>
            <label class="field"><span>Agency timezone</span>
              <select bind:value={dueTz}>
                {#each timezoneOptions(b.timezone) as tz (tz)}<option value={tz}>{tz}</option>{/each}
              </select>
            </label>
            <button class="btn" type="button" onclick={() => (converting = false)}>Cancel</button>
            <button class="btn primary" type="submit" disabled={!dueLocal}>Convert</button>
          </form>
          <p class="hint">It becomes a formal bid with this due date and the standard checklist (if it has none yet). Vendors, contacts and notes stay.</p>
        {/if}
      {/if}
    </section>

    <div class="cols">
      <div class="col main">
        <VendorsSection {data} />
        <PricingSection {data} />
        <section class="card box">
          <h2>History</h2>
          <ol class="hist">
            {#each history as h (h.id)}
              <li style:--dc={HIST_COLOR[h.kind]}><time datetime={h.iso}>{when(h.iso)}</time><span>{h.detail}</span></li>
            {/each}
          </ol>
        </section>
        <Checklist {data} />
      </div>
      <div class="col side">
        <ContactsSection {data} />
        <section class="card box">
          <div class="nhead">
            <h2>Notes</h2>
            {#if notes === null}<button class="btn sm" onclick={() => (notes = b.notes ?? '')}>Edit</button>{/if}
          </div>
          {#if notes === null}
            <p class="pre">{b.notes || '—'}</p>
          {:else}
            <textarea class="notes" bind:value={notes} rows="5" aria-label="Notes"></textarea>
            <div class="row end">
              <button class="btn" onclick={() => (notes = null)}>Cancel</button>
              <button class="btn primary" onclick={saveNotes}>Save</button>
            </div>
          {/if}
        </section>
      </div>
    </div>
  </section>
{/if}

<style>
  .topbar { display: flex; gap: 8px; align-items: center; }
  .spacer { flex: 1; }
  .head { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .head .badge { width: 52px; height: 52px; font-size: 24px; }
  .titles { flex: 1 1 400px; display: flex; flex-direction: column; gap: 4px; }
  h1 { font-size: 28px; }
  .sub { color: var(--ink-2); }
  .state { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .stage { font-family: var(--display); font-size: 20px; font-weight: 700; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .row.end { justify-content: flex-end; }
  .sep { width: 1px; height: 24px; background: var(--line); margin: 0 4px; }
  .closed { margin: 0; }
  .convert { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
  .cols { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .main { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  .side { flex: 1 1 300px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .hist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .hist li { display: grid; grid-template-columns: 150px 1fr; gap: 10px; align-items: baseline; padding-left: 14px; position: relative; font-size: 13px; }
  .hist li::before { content: ''; position: absolute; left: 0; top: 5px; width: 8px; height: 8px; border-radius: 50%; background: var(--dc); }
  .hist time { color: var(--muted); font-variant-numeric: tabular-nums; }
  .nhead { display: flex; justify-content: space-between; align-items: center; }
  .btn.sm { height: 30px; padding: 0 10px; font-size: 12px; }
  .pre { margin: 0; white-space: pre-wrap; }
  .notes { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; resize: vertical; }
  .owner-pick { height: 28px; border: 1px solid var(--line); border-radius: 8px; padding: 0 6px; font: inherit; }
</style>
