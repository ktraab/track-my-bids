<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { makeWindow, layoutLine, weekTicks, pctOf } from '$lib/domain/transitLayout';
  import { rowStatus, sortByUrgency } from '$lib/domain/rowStatus';
  import { networkSummary } from '$lib/domain/summary';
  import { formatMoneyShort } from '$lib/domain/format';
  import { formatCountdown, formatDateTime, formatStopDate, toMs } from '$lib/domain/time';
  import { idleDays, isStale } from '$lib/domain/stale';
  import {
    applyNetworkFilters, applySavedView, networkPool, activeFilterCount, EMPTY_NETWORK_FILTERS,
    SAVED_VIEWS, SAVED_VIEW_LABELS, CLOSED_RFQ_DAYS, type KindFilter, type NetworkFilters,
  } from '$lib/domain/networkFilters';
  import { OPEN_STAGES, OUTCOMES, STAGE_LABELS, RFQ_STAGE_LABELS, stageLabel } from '$lib/domain/stages';
  import { AGENCY_TYPE_LABELS, METHOD_LABELS } from '$lib/domain/labels';
  import { HOLDERS, receivedIso, type Holder } from '$lib/domain/rfq';
  import type { AgencyType, Method, Stage } from '$lib/domain/types';
  import { initials } from '$lib/domain/ownership';
  import { erateSummary } from '$lib/domain/erate';
  import { syncLabel, syncTone } from '$lib/sync/statusText';
  import TransitLine from './TransitLine.svelte';
  import HoverCard from './HoverCard.svelte';
  import StatusCell from './StatusCell.svelte';
  import NeedsYou from './NeedsYou.svelte';

  const DAY = 86_400_000;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let offsetWeeks = $state(0);
  let span = $state(30);

  const win = $derived(makeWindow({ nowMs: app.nowMs, zone, anchorMs: app.nowMs + offsetWeeks * 7 * DAY, daysAhead: span }));
  const ctx = $derived({ nowMs: app.nowMs, zone, followUp: app.followUp, team: app.team.mode === 'team', activeMemberIds: app.activeMemberIds });
  const f = $derived(app.networkFilters);
  const onNetwork = $derived(networkPool(app.bids, f, app.nowMs));
  const visible = $derived(applyNetworkFilters(onNetwork, f, app.meId, ctx));
  const teamOn = $derived(app.team.mode === 'team');
  const others = $derived(app.team.members.filter((m) => m.active && m.role !== 'pending' && m.id !== app.meId));
  const rows = $derived(
    sortByUrgency(visible, ctx).map((data) => ({
      data,
      line: layoutLine(data, win, { zone, followUp: app.followUp }),
      status: rowStatus(data, ctx),
    })),
  );
  // Hide week labels that would sit under the TODAY pill; keep edge labels inside the track.
  const ticks = $derived(
    weekTicks(win, zone)
      .filter((t) => todayPct === null || Math.abs(t.pct - todayPct) > 4)
      .map((t) => ({ ...t, edge: t.pct < 3 ? 'start' : t.pct > 97 ? 'end' : '' })),
  );
  const todayPct = $derived(app.nowMs >= win.startMs && app.nowMs <= win.endMs ? pctOf(app.nowMs, win) : null);
  const summary = $derived(networkSummary(app.bids, app.nowMs));
  const FILTER_STAGES: Stage[] = [...OPEN_STAGES, 'submitted'];
  const RFQ_FILTER_STAGES: Stage[] = ['reviewing', 'submitted'];
  const routeChips = $derived(f.kind === 'rfq' ? RFQ_FILTER_STAGES : FILTER_STAGES);
  const chipLabel = (s: Stage) => (f.kind === 'rfq' ? RFQ_STAGE_LABELS[s] : STAGE_LABELS[s]);
  const KINDS: [KindFilter, string][] = [['all', 'All'], ['bid', 'Bids'], ['rfq', 'Quotes']];
  const BALL_CHIPS: Record<Holder, string> = { us: 'On us', vendor: 'Waiting on vendor', customer: 'With customer' };
  const BALL_COLORS: Record<Holder, string> = { us: 'var(--us)', vendor: 'var(--vendor)', customer: 'var(--cust)' };

  /** Any manual filter change leaves the active saved view (search does not). */
  function setFilters(patch: Partial<NetworkFilters>) {
    void app.setNetworkFilters({ ...app.networkFilters, ...patch, view: null });
  }
  function toggle<K extends 'stages' | 'agencyTypes' | 'methods' | 'balls'>(key: K, v: NetworkFilters[K][number]) {
    const cur = app.networkFilters[key] as string[];
    setFilters({ [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } as Partial<NetworkFilters>);
  }
  // Hover card: only when the pointer rests on a row's name column (or the
  // name button has keyboard focus) for HOVER_DELAY ms. Moving restarts the wait.
  const HOVER_DELAY = 600;
  const HOVER_ID = 'bid-hover-card';
  let hover = $state<{ id: string; left: number; top: number | null; bottom: number | null } | null>(null);
  let cardHeight = $state(240);
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  function clearTimer() {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  function scheduleHover(id: string, el: HTMLElement) {
    clearTimer();
    if (hover && hover.id !== id) hover = null;
    if (hover) return; // already showing for this row
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      const r = el.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left + 24, window.innerWidth - 440));
      const below = window.innerHeight - r.bottom;
      // Not enough room below: anchor the card's bottom just above the row, so its real height doesn't matter.
      const flip = below < Math.max(cardHeight, 200) + 16 && r.top > below;
      hover = flip
        ? { id, left, top: null, bottom: Math.max(8, window.innerHeight - r.top + 8) }
        : { id, left, top: r.bottom + 8, bottom: null };
    }, HOVER_DELAY);
  }
  function hideHover() {
    clearTimer();
    hover = null;
  }
  function onRowFocusOut(e: FocusEvent) {
    const row = e.currentTarget as HTMLElement;
    if (e.relatedTarget instanceof Node && row.contains(e.relatedTarget)) return;
    hideHover();
  }
  $effect(() => () => clearTimer());
  const hovered = $derived(hover ? app.bids.find((d) => d.bid.id === hover!.id) ?? null : null);
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && hideHover()} onscroll={hideHover} />

<section class="page">
  <header class="top">
    <div>
      <h1>Your bid network</h1>
      <p class="sub">Each bid is a line to its due date. Each quote is a line colored by who has the ball.</p>
    </div>
    <div class="controls">
      <div class="legend" aria-hidden="true">
        <span><i class="lg stop"></i>Stop</span>
        <span><i class="lg mand"></i>Mandatory</span>
        <span><i class="lg ship"></i>Ship by</span>
        <span><i class="lg term"></i>Due</span>
        <span><i class="lg hold" style:background="var(--us)"></i>On us</span>
        <span><i class="lg hold" style:background="var(--vendor)"></i>Vendor</span>
        <span><i class="lg hold" style:background="var(--cust)"></i>Customer</span>
      </div>
      <div class="nav">
        <button class="btn" aria-label="Previous week" onclick={() => offsetWeeks--}>‹</button>
        <button class="btn" onclick={() => (offsetWeeks = 0)} disabled={offsetWeeks === 0}>Today</button>
        <button class="btn" aria-label="Next week" onclick={() => offsetWeeks++}>›</button>
        <select class="btn" bind:value={span} aria-label="Days ahead">
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
          <option value={90}>90 days</option>
        </select>
      </div>
      <button class="btn" onclick={() => app.showContacts()}>Contacts</button>
      <button class="btn" onclick={() => (app.panel = 'digest')}>Briefing</button>
      <NeedsYou />
      <button class="btn bell" aria-label="Notifications, {app.unread} unread" onclick={() => (app.panel = 'inbox')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
        {#if app.unread > 0}<span class="count">{app.unread}</span>{/if}
      </button>
      {#if teamOn}
        <button class="btn sync" title={syncLabel(app.team.sync, app.nowMs)} aria-label="Team sync: {syncLabel(app.team.sync, app.nowMs)}" onclick={() => app.showSettings()}>
          <i class="dot {syncTone(app.team.sync)}"></i>
        </button>
      {/if}
      <button class="btn bell" aria-label="Settings" onclick={() => app.showSettings()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
      </button>
      <button class="btn" onclick={() => app.importDocumentFromPicker()} title="New bid from an RFP (PDF, Word or Excel) — or drop the file on the window">From document…</button>
      <button class="btn primary" onclick={() => (app.quickAddOpen = true)} title="New bid or quote (Ctrl/⌘ + N)">+ New</button>
    </div>
  </header>

  <div class="filters" role="group" aria-label="Filter the network">
    <div class="kind-seg" role="group" aria-label="Show">
      {#each KINDS as [k, label] (k)}
        <button class:on={f.kind === k} aria-pressed={f.kind === k} onclick={() => setFilters(k === 'bid' ? { kind: k, balls: [] } : { kind: k })}>{label}</button>
      {/each}
    </div>
    <span class="sep" aria-hidden="true"></span>
    {#if teamOn}
      <select class="btn owner-filter" aria-label="Whose work" value={f.owner}
        onchange={(e) => setFilters({ owner: e.currentTarget.value })}>
        <option value="mine">Mine</option>
        <option value="all">Everyone</option>
        {#each others as m (m.id)}<option value={m.id}>{m.displayName || m.email}</option>{/each}
        {#if !['mine', 'all'].includes(f.owner) && !others.some((m) => m.id === f.owner)}
          <option value={f.owner}>{app.memberName(f.owner)}</option>
        {/if}
      </select>
      <span class="sep" aria-hidden="true"></span>
    {/if}
    {#if f.kind !== 'bid'}
      <!-- Who-has-the-ball applies to quotes only; picking Bids clears it. -->
      {#each HOLDERS as h (h)}
        <button class="fchip" class:on={f.balls.includes(h)} aria-pressed={f.balls.includes(h)} title="Quotes only" onclick={() => toggle('balls', h)}>
          <i class="dot" style:background={BALL_COLORS[h]}></i>{BALL_CHIPS[h]}
        </button>
      {/each}
    {/if}
    <button class="fchip" class:on={f.overdueOnly} aria-pressed={f.overdueOnly} onclick={() => setFilters({ overdueOnly: !f.overdueOnly })}>
      <i class="dot" style:background="var(--red)"></i>Overdue only
    </button>
    <button class="fchip" class:on={f.erateOnly} aria-pressed={f.erateOnly} title="E-Rate (Form 470) bids only" onclick={() => setFilters({ erateOnly: !f.erateOnly })}>E-Rate</button>
    <input class="search" type="search" placeholder="Search agency, item, vendor" aria-label="Search the network"
      value={f.search} oninput={(e) => app.setNetworkSearch(e.currentTarget.value)} />
    <span class="sep" aria-hidden="true"></span>
    {#each routeChips as s (s)}
      <button class="fchip" class:on={f.stages.includes(s)} aria-pressed={f.stages.includes(s)} onclick={() => toggle('stages', s)}>{chipLabel(s)}</button>
    {/each}
    <span class="sep" aria-hidden="true"></span>
    {#each OUTCOMES as s (s)}
      <button class="fchip" class:on={f.stages.includes(s)} aria-pressed={f.stages.includes(s)} title="Show closed items marked {chipLabel(s)}" onclick={() => toggle('stages', s)}>{chipLabel(s)}</button>
    {/each}
    <span class="sep" aria-hidden="true"></span>
    {#each Object.entries(AGENCY_TYPE_LABELS) as [v, l] (v)}
      <button class="fchip" class:on={f.agencyTypes.includes(v as AgencyType)} aria-pressed={f.agencyTypes.includes(v as AgencyType)} onclick={() => toggle('agencyTypes', v as AgencyType)}>{l}</button>
    {/each}
    <span class="sep" aria-hidden="true"></span>
    {#each Object.entries(METHOD_LABELS) as [v, l] (v)}
      <button class="fchip" class:on={f.methods.includes(v as Method)} aria-pressed={f.methods.includes(v as Method)} onclick={() => toggle('methods', v as Method)}>{l}</button>
    {/each}
    {#if activeFilterCount(f)}
      <button class="linkish" onclick={() => app.setNetworkFilters(EMPTY_NETWORK_FILTERS)}>Clear filters</button>
    {/if}
    {#if activeFilterCount(f) || visible.length < onNetwork.length}
      <span class="hint">Showing {visible.length} of {onNetwork.length}</span>
    {/if}
  </div>
  <div class="filters saved" role="group" aria-label="Saved views">
    <span class="hint">Saved views:</span>
    {#each SAVED_VIEWS as v (v)}
      <button class="fchip view" class:on={f.view === v} aria-pressed={f.view === v} onclick={() => app.setNetworkFilters(applySavedView(f, v))}>{SAVED_VIEW_LABELS[v]}</button>
    {/each}
    <span class="hint">· Won, lost and no-reply quotes leave the map {CLOSED_RFQ_DAYS} days after their last update.</span>
  </div>

  <div class="card map">
    <div class="inner">
      <div class="axis">
        <div class="meta-col eyebrow">Line</div>
        <div class="status-head eyebrow">Status</div>
        <div class="ticks">
          {#each ticks as t (t.label)}
            <span class="tick {t.edge}" style:left="{t.pct}%">{t.label}</span>
          {/each}
          {#if todayPct !== null}
            <span class="today-pill" style:left="{todayPct}%">TODAY</span>
          {/if}
        </div>
      </div>

      {#each rows as r (r.data.bid.id)}
        {@const b = r.data.bid}
        <div
          class="row"
          role="group"
          aria-label="{b.kind === 'rfq' ? 'Quote' : 'Bid'}: {b.agencyName} {b.title}"
          onfocusout={onRowFocusOut}
        >
          <button
            class="meta-col meta"
            onclick={() => { hideHover(); app.open(b.id); }}
            onpointerenter={(e) => e.pointerType !== 'touch' && scheduleHover(b.id, e.currentTarget)}
            onpointermove={(e) => e.pointerType !== 'touch' && scheduleHover(b.id, e.currentTarget)}
            onpointerleave={hideHover}
            onfocus={(e) => scheduleHover(b.id, e.currentTarget)}
            aria-describedby={hover?.id === b.id ? HOVER_ID : undefined}
          >
            <span class="badge" class:qbadge={b.kind === 'rfq'} style:background={b.kind === 'rfq' ? null : b.lineColor}>{r.line.letter}</span>
            <span class="text">
              <strong>{b.agencyName}{#if b.erate}<em class="erate" title={erateSummary(b)}>E-Rate</em>{/if}{#if teamOn && b.ownerId}<em class="owner" title="Owner: {app.memberName(b.ownerId)}">{initials(app.memberName(b.ownerId))}</em>{/if}</strong>
              <span>{b.title}</span>
              <small>
                {#if b.kind === 'rfq'}
                  Quote · {stageLabel('rfq', b.stage)} · received {formatStopDate(receivedIso(b), zone)}
                {:else}
                  {formatMoneyShort(b.estValue)} · {METHOD_LABELS[b.submissionMethod]}{#if b.stage === 'submitted'} · Submitted{/if}
                {/if}
              </small>
              {#if isStale(b, app.nowMs)}
                <small class="idle">Idle {idleDays(b.lastTouchedAt, app.nowMs)} days</small>
              {/if}
            </span>
          </button>
          <StatusCell status={r.status} bid={b} />
          <TransitLine line={r.line} {todayPct} />
        </div>
      {:else}
        <div class="empty">
          {#if onNetwork.length > 0 && visible.length === 0}
            <p>Nothing matches these filters.</p>
            {#if activeFilterCount(f)}
              <button class="btn" onclick={() => app.setNetworkFilters(EMPTY_NETWORK_FILTERS)}>Clear filters</button>
            {:else}
              <button class="btn" onclick={() => app.setNetworkFilters({ ...f, owner: 'all' })}>Show everyone’s work</button>
            {/if}
          {:else if app.bids.length > 0}
            <p>Nothing open. Closed bids and older closed quotes are hidden from the network.</p>
          {:else}
            <p>Nothing on the network yet.</p>
          {/if}
          {#if !(onNetwork.length > 0 && visible.length === 0)}
            <button class="btn primary" onclick={() => (app.quickAddOpen = true)}>{app.bids.length > 0 ? 'New bid or quote' : 'Add your first bid or quote'}</button>
            <p class="hint">Shortcut: Ctrl/⌘ + N</p>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <div class="cards">
    <div class="card info">
      <div class="eyebrow">Next arrival</div>
      {#if summary.nextArrival}
        {@const n = summary.nextArrival}
        <button class="big linklike" onclick={() => app.open(n.bidId)}>{n.agencyName} · {n.label}</button>
        <div class="small">{formatDateTime(n.atIso, n.timezone)} · in {formatCountdown(app.nowMs, toMs(n.atIso))}</div>
      {:else}
        <div class="small">Nothing scheduled</div>
      {/if}
    </div>
    <div class="card info">
      <div class="eyebrow red">Mandatory stop</div>
      {#if summary.nextMandatory}
        {@const n = summary.nextMandatory}
        <button class="big linklike" onclick={() => app.open(n.bidId)}>{n.agencyName} · {n.label}</button>
        <div class="small">{formatDateTime(n.atIso, n.timezone)} · miss it and you're out</div>
      {:else}
        <div class="small">No mandatory meetings coming up</div>
      {/if}
    </div>
    <div class="card info">
      <div class="eyebrow">On the network</div>
      <div class="big">{summary.openCount} open {summary.openCount === 1 ? 'bid' : 'bids'} · {summary.quoteCount} {summary.quoteCount === 1 ? 'quote' : 'quotes'}</div>
      <div class="small">{formatMoneyShort(summary.pipeline)} in open bids</div>
      <div class="small">{summary.idleCount} idle 7+ days</div>
    </div>
  </div>
  {#if activeFilterCount(f)}
    <p class="hint cards-hint">Cards show all open work</p>
  {/if}
  {#if hover && hovered}<HoverCard id={HOVER_ID} data={hovered} top={hover.top} bottom={hover.bottom} left={hover.left} bind:height={cardHeight} />{/if}
</section>

<style>
  .filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .fchip { height: 30px; padding: 0 12px; border-radius: 15px; border: 1px solid var(--line); background: #fff; font-size: 13px; color: var(--ink-2); }
  .fchip.on { background: var(--ink); border-color: var(--ink); color: #fff; }
  .sep { width: 1px; height: 20px; background: var(--line); margin: 0 4px; }
  .bell { position: relative; width: 40px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  .count { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--red); color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 16px; }
  h1 { font-size: 30px; }
  .sub { margin: 4px 0 0; color: var(--muted); }
  .controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--ink-2); }
  .legend span { display: flex; align-items: center; gap: 6px; }
  .lg { display: inline-block; }
  .lg.stop { width: 12px; height: 12px; border-radius: 50%; border: 3px solid var(--ink); }
  .lg.mand { width: 12px; height: 12px; border-radius: 50%; background: var(--ink); box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--red); }
  .lg.ship { width: 10px; height: 10px; border: 3px solid var(--ink); transform: rotate(45deg); }
  .lg.term { width: 16px; height: 12px; border-radius: 3px; background: var(--ink); }
  .nav { display: flex; gap: 6px; }
  .map { overflow-x: auto; }
  .inner { min-width: 1200px; padding: 8px 24px 16px; }
  .axis, .row { display: flex; align-items: stretch; }
  .meta-col { width: 300px; flex: none; position: sticky; left: 0; z-index: 1; background: var(--card); }
  .axis { height: 40px; align-items: flex-end; }
  .ticks { position: relative; flex: 1; height: 40px; }
  .tick { position: absolute; bottom: 6px; transform: translateX(-50%); font-size: 12px; color: var(--muted); white-space: nowrap; }
  .tick.start { transform: none; }
  .tick.end { transform: translateX(-100%); }
  .today-pill {
    position: absolute; bottom: 0; transform: translateX(-50%); padding: 2px 8px; border-radius: 10px;
    background: var(--red); color: #fff; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
  }
  .row { border-top: 1px solid var(--line-soft); }
  .meta { display: flex; gap: 12px; align-items: center; padding: 8px 16px 8px 0; background: var(--card); border: 0; text-align: left; }
  .meta:hover strong { text-decoration: underline; }
  .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .text strong { font-size: 15px; }
  .text span { color: var(--ink-2); font-size: 13px; }
  .text small { color: var(--muted); font-size: 12px; }
  .text small.idle { color: var(--red); font-weight: 600; }
  .empty { padding: 48px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .cards { display: flex; flex-wrap: wrap; gap: 16px; }
  .info { flex: 1 1 300px; padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; }
  .big { font-family: var(--display); font-size: 20px; font-weight: 700; }
  .linklike { background: none; border: 0; padding: 0; text-align: left; }
  .linklike:hover { text-decoration: underline; }
  .small { font-size: 13px; color: var(--ink-2); }
  .cards-hint { margin-top: -8px; }
  .owner { display: inline-block; margin-left: 8px; padding: 1px 6px; border-radius: 9px; background: var(--line-soft, #eef1f5); color: var(--ink-2); font-size: 11px; font-style: normal; font-weight: 600; vertical-align: 2px; }
  .owner-filter { height: 30px; font-size: 13px; }
  .erate { display: inline-block; margin-left: 8px; padding: 1px 6px; border-radius: 9px; background: #e3eefc; color: #1d4f99; font-size: 11px; font-style: normal; font-weight: 600; vertical-align: 2px; }
  .btn.sync { width: 36px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #9aa5b1; }
  .dot.ok { background: #2f9e57; }
  .dot.busy { background: #2f7de1; animation: pulse 1s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .dot.busy { animation: none; } }
  .dot.bad { background: var(--red); }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .status-head { width: 200px; flex: none; position: sticky; left: 300px; z-index: 1; background: var(--card); padding: 0 10px 6px; }
  .kind-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 15px; overflow: hidden; }
  .kind-seg button { height: 30px; padding: 0 12px; border: 0; background: #fff; font-size: 13px; font-weight: 600; color: var(--ink-2); }
  .kind-seg button + button { border-left: 1px solid var(--line); }
  .kind-seg button.on { background: var(--ink); color: #fff; }
  .fchip .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 0; }
  .search { height: 30px; width: 220px; padding: 0 12px; border: 1px solid var(--line); border-radius: 15px; background: #fff; font-size: 13px; }
  .saved { margin-top: -12px; }
  .fchip.view { height: 26px; font-size: 12px; border-style: dashed; }
  .lg.hold { width: 16px; height: 4px; border-radius: 2px; }
</style>
