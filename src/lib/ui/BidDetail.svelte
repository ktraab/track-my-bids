<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { app } from '$lib/state.svelte';
  import { layoutLine, pctOf, windowAround } from '$lib/domain/transitLayout';
  import { ROUTE, OUTCOMES, STAGE_LABELS, routeIndex } from '$lib/domain/stages';
  import { AGENCY_TYPE_LABELS, METHOD_LABELS, SHIP_METHOD_LABELS } from '$lib/domain/labels';
  import { dayWarnings } from '$lib/domain/dayWarnings';
  import { formatMoneyShort } from '$lib/domain/format';
  import { formatCountdown, formatDateTime, shipByIso, toMs } from '$lib/domain/time';
  import type { Stage } from '$lib/domain/types';
  import TransitLine from './TransitLine.svelte';
  import BidForm from './BidForm.svelte';
  import MilestoneList from './MilestoneList.svelte';
  import Checklist from './Checklist.svelte';
  import CalendarMenu from './CalendarMenu.svelte';
  import ContactsSection from './ContactsSection.svelte';

  let { id }: { id: string } = $props();
  let editing = $state(false);
  let confirmDelete = $state(false);

  const data = $derived(app.bids.find((d) => d.bid.id === id));
  const due = $derived(data?.milestones.find((m) => m.type === 'due'));
  const win = $derived(data ? windowAround(data, app.nowMs, data.bid.timezone) : null);
  const line = $derived(data && win ? layoutLine(data, win) : null);
  const todayPct = $derived(win ? pctOf(app.nowMs, win) : null);
  const warnings = $derived(data ? dayWarnings(data, app.nowMs) : []);
  const stageIdx = $derived(data ? routeIndex(data.bid.stage) : 0);

  /** Ship-by is derived; never let a bad value crash rendering. */
  function shipByLabel(dueAt: string, tz: string, lead: number): string {
    if (!Number.isInteger(lead) || lead < 0) return '—';
    try { return formatDateTime(shipByIso(dueAt, tz, lead), tz); } catch { return '—'; }
  }
  function dueCountdown(iso: string): string {
    try {
      const ms = toMs(iso);
      return ms >= app.nowMs ? formatCountdown(app.nowMs, ms) : 'Closed';
    } catch { return '—'; }
  }

  function open(url: string) {
    openUrl(url).catch((e) => (app.error = `Could not open link: ${e instanceof Error ? e.message : e}`));
  }

  async function setStage(s: Stage, el?: HTMLSelectElement) {
    if (!data) return;
    const ok = await app.updateBid(data.bid.id, { stage: s });
    if (!ok && el) el.value = OUTCOMES.includes(data.bid.stage) ? data.bid.stage : '';
  }
</script>

{#if !data}
  <section class="page">
    <button class="btn" onclick={() => app.home()}>‹ Network</button>
    <p>This bid no longer exists.</p>
  </section>
{:else}
  {@const b = data.bid}
  <section class="page">
    <div class="topbar">
      <button class="btn" onclick={() => app.home()}>‹ Network</button>
      <div class="spacer"></div>
      <CalendarMenu bidId={b.id} label="Add all to calendar" compact={false} />
      <button class="btn" onclick={() => (editing = !editing)}>{editing ? 'Close editor' : 'Edit details'}</button>
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
      <span class="badge" style:background={b.lineColor}>{line?.letter}</span>
      <div class="titles">
        <div class="eyebrow">{b.bidNumber ?? 'No bid #'} · {AGENCY_TYPE_LABELS[b.agencyType]}</div>
        <h1>{b.title}</h1>
        <div class="sub">{b.agencyName} · {formatMoneyShort(b.estValue)} · <span class="method">{METHOD_LABELS[b.submissionMethod]}</span>
          {#if app.team.mode === 'team'}
            · Owner
            {#if app.canManage(b)}
              {@const owners = app.team.members.filter((m) => m.active && m.role !== 'pending')}
              <select class="owner-pick" aria-label="Owner" value={b.ownerId ?? ''} onchange={async (e) => { const el = e.currentTarget; if (!(await app.setOwner(b.id, el.value))) el.value = b.ownerId ?? ''; }}>
                {#if !owners.some((m) => m.id === b.ownerId)}<option value={b.ownerId ?? ''} disabled>{b.ownerId ? app.memberName(b.ownerId) : 'Unassigned'}</option>{/if}
                {#each owners as m (m.id)}<option value={m.id}>{m.displayName || m.email}</option>{/each}
              </select>
            {:else}
              <strong>{app.memberName(b.ownerId)}</strong>
            {/if}
          {/if}
        </div>
      </div>
      {#if due}
        <div class="countdown">
          <div class="eyebrow">Due</div>
          <div class="cd">{dueCountdown(due.at)}</div>
          <div class="hint">{formatDateTime(due.at, b.timezone)}</div>
        </div>
      {/if}
    </header>

    {#if warnings.length}
      <div class="warns" role="status">
        {#each warnings as w (w.text)}<div class="warn">⚠ {w.text}</div>{/each}
      </div>
    {/if}

    {#if editing}
      {#key b.id}<BidForm bid={b} onDone={() => (editing = false)} />{/key}
    {/if}

    <nav class="card route" aria-label="Stage">
      {#each ROUTE as s, i (s)}
        <button class="step" class:done={i < stageIdx} class:current={s === b.stage} aria-pressed={s === b.stage} onclick={() => setStage(s)}>
          <span class="dot">{i < stageIdx ? '✓' : ''}</span>{STAGE_LABELS[s]}
        </button>
      {/each}
      <label class="outcome">
        <span class="eyebrow">Outcome</span>
        <select value={OUTCOMES.includes(b.stage) ? b.stage : ''}
          onchange={(e) => { const v = e.currentTarget.value as Stage | ''; if (v) setStage(v, e.currentTarget); }}>
          <option value="" disabled>—</option>
          {#each OUTCOMES as o (o)}<option value={o}>{STAGE_LABELS[o]}</option>{/each}
        </select>
      </label>
    </nav>

    {#if line}
      <div class="card timeline"><TransitLine {line} height={130} {todayPct} /></div>
    {/if}

    <div class="cols">
      <div class="col main">
        <Checklist {data} />
        <MilestoneList {data} />
      </div>
      <div class="col side">
      <ContactsSection {data} />
      <aside class="card box">
        <h2>Details</h2>
        <dl>
          <dt>Scope</dt><dd class="pre">{b.scope || '—'}</dd>
          {#if b.submissionMethod === 'online'}
            <dt>Portal</dt>
            <dd>{b.portalName || '—'}{#if b.portalUrl} · <button class="linkish" onclick={() => open(b.portalUrl!)}>Open portal</button>{/if}</dd>
          {:else if b.submissionMethod === 'sealed'}
            <dt>Deliver to</dt><dd class="pre">{b.deliveryAddress || '—'}</dd>
            <dt>Copies / notary</dt><dd>{b.copiesRequired ?? '—'} copies · {b.notarizeRequired ? 'Notarize' : 'No notary'}</dd>
            <dt>Ship</dt>
            <dd>{b.shipMethod ? SHIP_METHOD_LABELS[b.shipMethod] : '—'}{#if due} · ship by {shipByLabel(due.at, b.timezone, b.shipLeadBusinessDays)}{/if}</dd>
          {/if}
          <dt>RFP</dt>
          <dd>{#if b.rfpUrl}<button class="linkish" onclick={() => open(b.rfpUrl!)}>Open RFP</button>{:else}—{/if}</dd>
          <dt>Notes</dt><dd class="pre">{b.notes || '—'}</dd>
          <dt>Agency timezone</dt><dd>{b.timezone}</dd>
        </dl>
      </aside>
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
  .method { font-weight: 600; }
  .countdown { text-align: right; }
  .cd { font-family: var(--display); font-size: 28px; font-weight: 700; }
.warns { display: flex; flex-direction: column; gap: 6px; }
  .warn { padding: 8px 12px; border-radius: 8px; background: #fff7e6; color: #7a4b00; font-size: 14px; }
  .route { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 10px 14px; }
  .step { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 20px; border: 0; background: none; color: var(--muted); font-weight: 600; }
  .step.done { color: var(--ink); }
  .step.current { background: var(--ink); color: #fff; }
  .dot { width: 20px; height: 20px; border-radius: 50%; border: 2px solid currentColor; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
  .step.done .dot { background: var(--ink); color: #fff; border-color: var(--ink); }
  .outcome { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .outcome select { height: 34px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; background: #fff; }
  .timeline { padding: 8px 40px; overflow-x: auto; }
  .timeline :global(.track) { min-width: 700px; }
  .cols { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .main { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  .side { flex: 1 1 300px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 8px 14px; }
  dt { font-size: 12px; font-weight: 600; color: var(--muted); }
  dd { margin: 0; }
  .pre { white-space: pre-wrap; }
  .owner-pick { height: 28px; border: 1px solid var(--line); border-radius: 8px; padding: 0 6px; font: inherit; }
</style>
