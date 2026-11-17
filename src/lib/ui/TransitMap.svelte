<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { makeWindow, layoutLine, weekTicks, sortByNextMilestone, pctOf } from '$lib/domain/transitLayout';
  import { networkSummary } from '$lib/domain/summary';
  import { formatMoneyShort } from '$lib/domain/format';
  import { formatCountdown, formatDateTime, toMs } from '$lib/domain/time';
  import { idleDays, isStale } from '$lib/domain/stale';
  import { applyNetworkFilters, networkPool, activeFilterCount, EMPTY_NETWORK_FILTERS, type NetworkFilters } from '$lib/domain/networkFilters';
  import { OPEN_STAGES, OUTCOMES, STAGE_LABELS } from '$lib/domain/stages';
  import { AGENCY_TYPE_LABELS, METHOD_LABELS } from '$lib/domain/labels';
  import type { AgencyType, BidWithChildren, Method, Stage } from '$lib/domain/types';
  import { initials } from '$lib/domain/ownership';
  import { syncLabel, syncTone } from '$lib/sync/statusText';
  import TransitLine from './TransitLine.svelte';
  import HoverCard from './HoverCard.svelte';

  const DAY = 86_400_000;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let offsetWeeks = $state(0);
  let span = $state(30);

  const win = $derived(makeWindow({ nowMs: app.nowMs, zone, anchorMs: app.nowMs + offsetWeeks * 7 * DAY, daysAhead: span }));
  const onNetwork = $derived(networkPool(app.bids, app.networkFilters));
  const visible = $derived(applyNetworkFilters(onNetwork, app.networkFilters, app.meId));
  const teamOn = $derived(app.team.mode === 'team');
  const others = $derived(app.team.members.filter((m) => m.active && m.role !== 'pending' && m.id !== app.meId));
  const rows = $derived(
    sortByNextMilestone(visible, app.nowMs).map((data) => ({
      data,
      line: layoutLine(data, win),
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
  function toggle<K extends keyof NetworkFilters>(key: K, v: NetworkFilters[K][number]) {
    const cur = app.networkFilters[key] as string[];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    void app.setNetworkFilters({ ...app.networkFilters, [key]: next });
  }
  // Hover card: only when the pointer rests on a bid's name column (or the
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
    if (hover) return; // already showing for this bid
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
  const doneCount = (d: BidWithChildren) => d.checklist.filter((c) => c.done).length;
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && hideHover()} onscroll={hideHover} />

<section class="page">
  <header class="top">
    <div>
      <h1>Your bid network</h1>
      <p class="sub">Each bid is a line. Stops are milestones. The terminus is submission.</p>
    </div>
    <div class="controls">
      <div class="legend" aria-hidden="true">
        <span><i class="lg stop"></i>Stop</span>
        <span><i class="lg mand"></i>Mandatory</span>
        <span><i class="lg ship"></i>Ship by</span>
        <span><i class="lg term"></i>Due</span>
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
      <button class="btn primary" onclick={() => (app.quickAddOpen = true)}>+ New bid</button>
    </div>
  </header>

  <div class="filters" role="group" aria-label="Filter the network">
    {#if teamOn}
      <select class="btn owner-filter" aria-label="Whose bids" value={app.networkFilters.owner}
        onchange={(e) => app.setNetworkFilters({ ...app.networkFilters, owner: e.currentTarget.value })}>
        <option value="mine">My bids</option>
        <option value="all">Everyone</option>
        {#each others as m (m.id)}<option value={m.id}>{m.displayName || m.email}</option>{/each}
        {#if !['mine', 'all'].includes(app.networkFilters.owner) && !others.some((m) => m.id === app.networkFilters.owner)}
          <option value={app.networkFilters.owner}>{app.memberName(app.networkFilters.owner)}</option>
        {/if}
      </select>
      <span class="sep" aria-hidden="true"></span>
    {/if}
    {#each FILTER_STAGES as s (s)}
      <button class="fchip" class:on={app.networkFilters.stages.includes(s)} aria-pressed={app.networkFilters.stages.includes(s)} onclick={() => toggle('stages', s)}>{STAGE_LABELS[s]}</button>
    {/each}
    <span class="sep" aria-hidden="true"></span>
    {#each OUTCOMES as s (s)}
      <button class="fchip" class:on={app.networkFilters.stages.includes(s)} aria-pressed={app.networkFilters.stages.includes(s)} title="Show closed bids marked {STAGE_LABELS[s]}" onclick={() => toggle('stages', s)}>{STAGE_LABELS[s]}</button>
    {/each}
    <span class="sep" aria-hidden="true"></span>
    {#each Object.entries(AGENCY_TYPE_LABELS) as [v, l] (v)}
      <button class="fchip" class:on={app.networkFilters.agencyTypes.includes(v as AgencyType)} aria-pressed={app.networkFilters.agencyTypes.includes(v as AgencyType)} onclick={() => toggle('agencyTypes', v as AgencyType)}>{l}</button>
    {/each}
    <span class="sep" aria-hidden="true"></span>
    {#each Object.entries(METHOD_LABELS) as [v, l] (v)}
      <button class="fchip" class:on={app.networkFilters.methods.includes(v as Method)} aria-pressed={app.networkFilters.methods.includes(v as Method)} onclick={() => toggle('methods', v as Method)}>{l}</button>
    {/each}
    {#if activeFilterCount(app.networkFilters)}
      <button class="linkish" onclick={() => app.setNetworkFilters(EMPTY_NETWORK_FILTERS)}>Clear filters</button>
    {/if}
    {#if activeFilterCount(app.networkFilters) || visible.length < onNetwork.length}
      <span class="hint">Showing {visible.length} of {onNetwork.length}</span>
    {/if}
  </div>

  <div class="card map">
    <div class="inner">
      <div class="axis">
        <div class="meta-col eyebrow">Line</div>
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
          aria-label="{b.agencyName} {b.title}"
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
            <span class="badge" style:background={b.lineColor}>{r.line.letter}</span>
            <span class="text">
              <strong>{b.agencyName}{#if teamOn && b.ownerId}<em class="owner" title="Owner: {app.memberName(b.ownerId)}">{initials(app.memberName(b.ownerId))}</em>{/if}</strong>
              <span>{b.title}</span>
              <small>
                {formatMoneyShort(b.estValue)} · {METHOD_LABELS[b.submissionMethod]} · {doneCount(r.data)}/{r.data.checklist.length} done{#if b.stage === 'submitted'} · Submitted{/if}
              </small>
              {#if isStale(b, app.nowMs)}
                <small class="idle">Idle {idleDays(b.lastTouchedAt, app.nowMs)} days</small>
              {/if}
            </span>
          </button>
          <TransitLine line={r.line} {todayPct} />
        </div>
      {:else}
        <div class="empty">
          {#if onNetwork.length > 0 && visible.length === 0}
            <p>No bids match these filters.</p>
            {#if activeFilterCount(app.networkFilters)}
              <button class="btn" onclick={() => app.setNetworkFilters(EMPTY_NETWORK_FILTERS)}>Clear filters</button>
            {:else}
              <button class="btn" onclick={() => app.setNetworkFilters({ ...app.networkFilters, owner: 'all' })}>Show everyone’s bids</button>
            {/if}
          {:else if app.bids.length > 0}
            <p>No open bids. Awarded/lost bids are hidden from the network.</p>
          {:else}
            <p>No bids on the network yet.</p>
          {/if}
          {#if !(onNetwork.length > 0 && visible.length === 0)}
            <button class="btn primary" onclick={() => (app.quickAddOpen = true)}>{app.bids.length > 0 ? 'New bid' : 'Add your first bid'}</button>
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
      <div class="big">{summary.openCount} open · {formatMoneyShort(summary.pipeline)}</div>
      <div class="small">{summary.idleCount} idle 7+ days</div>
    </div>
  </div>
  {#if activeFilterCount(app.networkFilters)}
    <p class="hint cards-hint">Cards show all open bids</p>
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
  .inner { min-width: 1000px; padding: 8px 24px 16px; }
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
  .btn.sync { width: 36px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #9aa5b1; }
  .dot.ok { background: #2f9e57; }
  .dot.busy { background: #2f7de1; animation: pulse 1s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .dot.busy { animation: none; } }
  .dot.bad { background: var(--red); }
  @keyframes pulse { 50% { opacity: 0.35; } }
</style>
