<script lang="ts">
  import { tick } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { NEEDS_TABS, NEEDS_TAB_LABELS, needsBadge, needsCounts, type NeedsItem, type NeedsTab } from '$lib/domain/needsYou';
  import { lineLetter } from '$lib/domain/palette';

  let open = $state(false);
  let tab = $state<NeedsTab>('all');
  let busy = $state<string | null>(null);
  let wrap: HTMLDivElement | undefined = $state();
  let btn: HTMLButtonElement | undefined = $state();
  let pop: HTMLDivElement | undefined = $state();
  /** Item keys in the order they had when the popover opened, so rows don't jump under the cursor. */
  let order = $state<string[]>([]);
  let place = $state({ top: 0, left: 0, width: 460, maxH: 480, arrow: 22 });

  const teamOn = $derived(app.team.mode === 'team');
  const items = $derived(app.needs);
  const badge = $derived(needsBadge(items));
  const counts = $derived(needsCounts(items));
  /** Unclaimed only exists in Team mode. */
  const tabs = $derived(NEEDS_TABS.filter((t) => t !== 'unclaimed' || teamOn));
  /** The selected tab may no longer exist (e.g. Unclaimed after leaving Team mode). */
  const activeTab = $derived<NeedsTab>(tabs.includes(tab) ? tab : 'all');
  const list = $derived.by(() => {
    const base = activeTab === 'all' ? items : items.filter((i) => i.rule === activeTab);
    if (!open) return base;
    const idx = new Map(order.map((k, n) => [k, n]));
    const kept = base.filter((i) => idx.has(i.key)).sort((a, b) => idx.get(a.key)! - idx.get(b.key)!);
    return [...kept, ...base.filter((i) => !idx.has(i.key))];
  });
  const owners = $derived(app.team.members.filter((m) => m.active && m.role !== 'pending' && m.id !== app.meId));
  const label = $derived(
    badge.count ? `Needs you, ${badge.count} item${badge.count === 1 ? '' : 's'}${badge.overdue ? ', some overdue' : ''}` : 'Needs you, nothing right now');

  function reposition() {
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = Math.min(460, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.right + 8 - width, window.innerWidth - width - 8));
    const top = r.bottom + 10;
    const arrow = Math.max(8, Math.min(left + width - (r.left + r.width / 2) - 6, width - 20));
    place = { top, left, width, maxH: Math.max(160, window.innerHeight - top - 8), arrow };
  }
  async function show() {
    order = items.map((i) => i.key);
    reposition();
    open = true;
    await tick();
    pop?.querySelector<HTMLElement>('.tabs button[aria-pressed="true"]')?.focus();
  }
  function close(returnFocus = true) {
    open = false;
    if (returnFocus) btn?.focus();
  }
  function onKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      close();
    }
  }
  /** Focus moved to a real element outside the popover; a null relatedTarget (click on non-focusable area) is ignored. */
  function onFocusOut(e: FocusEvent) {
    const to = e.relatedTarget;
    if (open && wrap && e.target instanceof Node && wrap.contains(e.target) && to instanceof Node && !wrap.contains(to)) close(false);
  }
  function onPointer(e: PointerEvent) {
    if (open && wrap && e.target instanceof Node && !wrap.contains(e.target)) close(false);
  }

  /** Run an action; when its item disappears, keep keyboard focus inside the popover. */
  async function act(i: NeedsItem, action: string, fn: () => Promise<unknown>) {
    if (busy) return;
    busy = i.key;
    try {
      await fn();
    } finally {
      busy = null;
    }
    await tick();
    if (!open || !pop || pop.contains(document.activeElement) && document.activeElement !== pop) return;
    if (items.some((n) => n.key === i.key)) {
      const again = [...pop.querySelectorAll<HTMLElement>('[data-key]')].find((el) => el.dataset.key === i.key && el.dataset.action === action);
      if (again) { again.focus(); return; }
    }
    pop.querySelector<HTMLElement>('.x')?.focus();
  }
  function openBid(id: string) {
    close(false);
    app.open(id);
  }
  const lineColor = (bidId: string) => app.bids.find((d) => d.bid.id === bidId)?.bid.lineColor ?? 'var(--ink-2)';
</script>

<svelte:window onkeydown={onKey} onpointerdown={onPointer} onfocusout={onFocusOut} onresize={() => open && reposition()} />

<div class="needs" bind:this={wrap}>
  <button bind:this={btn} class="btn hand" aria-label={label} title="Needs you" aria-haspopup="dialog" aria-expanded={open} aria-controls="needs-pop"
    onclick={() => (open ? close() : show())}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-4 0v0"></path><path d="M14 10V4a2 2 0 0 0-4 0v2"></path><path d="M10 10.5V6a2 2 0 0 0-4 0v8"></path><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"></path></svg>
    {#if badge.count > 0}<span class="count" class:grey={!badge.overdue}>{badge.count}</span>{/if}
  </button>

  {#if open}
    <div bind:this={pop} id="needs-pop" class="pop" role="dialog" aria-label="Needs you"
      style:top="{place.top}px" style:left="{place.left}px" style:width="{place.width}px" style:max-height="{place.maxH}px" style:--arrow="{place.arrow}px">
      <div class="pop-h">
        <h3>Needs you</h3>
        <span class="eyebrow">{badge.count === 1 ? '1 item' : `${badge.count} items`}</span>
        <span class="sp"></span>
        <button class="mini x" aria-label="Close" onclick={() => close()}>✕</button>
      </div>
      <div class="tabs" role="group" aria-label="Show">
        {#each tabs as t (t)}
          <button class="chip" class:on={activeTab === t} aria-pressed={activeTab === t} onclick={() => (tab = t)}>{NEEDS_TAB_LABELS[t]} {counts[t]}</button>
        {/each}
      </div>
      <ul class="list">
        {#each list as i (i.key)}
          <li class="item">
            {#if i.kind === 'rfq'}
              <span class="badge qbadge" aria-hidden="true">{lineLetter(i.title)}</span>
            {:else}
              <span class="badge" style:background={lineColor(i.bidId)} aria-hidden="true">{lineLetter(i.title)}</span>
            {/if}
            <div class="mt">
              <button class="name" onclick={() => openBid(i.bidId)} title="Open">{i.title} <span class="sub">· {i.subtitle}</span></button>
              <span class="why" class:late-text={i.overdue}>{i.why}</span>
            </div>
            <div class="acts">
              {#if i.rule === 'vendor'}
                <button class="mini primary" disabled={!!busy} data-key={i.key} data-action="nudge" onclick={() => act(i, 'nudge', () => app.nudgeVendor(i.bidId, i.targetId))}>Nudge {i.vendorName}</button>
                <button class="mini" disabled={!!busy} data-key={i.key} data-action="skip" onclick={() => act(i, 'skip', () => app.setVendorSkipped(i.targetId, true))}>Quote without them</button>
              {:else if i.rule === 'unclaimed'}
                <button class="mini primary" disabled={!!busy} data-key={i.key} data-action="claim" onclick={() => act(i, 'claim', () => app.claim(i.bidId))}>Claim</button>
                {#if owners.length}
                  <select class="mini" aria-label="Assign {i.title} to" disabled={!!busy} data-key={i.key} data-action="assign"
                    onchange={async (e) => {
                      const el = e.currentTarget;
                      const id = el.value;
                      if (!id) return;
                      try { await act(i, 'assign', () => app.setOwner(i.bidId, id)); } finally { el.value = ''; }
                    }}>
                    <option value="" selected>Assign…</option>
                    {#each owners as m (m.id)}<option value={m.id}>{m.displayName || m.email}</option>{/each}
                  </select>
                {/if}
              {:else if i.rule === 'customer'}
                <button class="mini primary" disabled={!!busy} data-key={i.key} data-action="followed" onclick={() => act(i, 'followed', () => app.markFollowedUp(i.bidId))}>Followed up</button>
              {:else}
                <button class="mini primary" onclick={() => openBid(i.bidId)}>Open bid</button>
                <button class="mini" disabled={!!busy} data-key={i.key} data-action="done" onclick={() => act(i, 'done', () => app.updateMilestone(i.targetId, { done: true }))}>Mark done</button>
              {/if}
              <button class="mini snooze" disabled={!!busy} aria-label="Snooze {i.title} for 1 day" title="Snooze 1 day" data-key={i.key} data-action="snooze"
                onclick={() => act(i, 'snooze', () => app.snoozeNeeds(i.key))}>Snooze</button>
            </div>
          </li>
        {:else}
          <li class="done-msg">{items.length ? 'Nothing in this group.' : 'All clear. Nothing needs you right now.'}</li>
        {/each}
      </ul>
      <div class="pop-f">Clears when you act. Snooze hides an item for 1 day on this computer.</div>
    </div>
  {/if}
</div>

<style>
  .needs { position: relative; display: inline-flex; }
  .hand { position: relative; width: 40px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  .count { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--red); color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .count.grey { background: var(--muted); }
  .pop {
    position: fixed; z-index: 40; min-height: 0;
    background: var(--card); border: 1px solid var(--line); border-radius: 12px; text-align: left;
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.14), 0 2px 6px rgb(0 0 0 / 0.06); display: flex; flex-direction: column;
  }
  .pop::before {
    content: ''; position: absolute; top: -7px; right: var(--arrow, 22px); width: 12px; height: 12px; background: var(--card);
    border-left: 1px solid var(--line); border-top: 1px solid var(--line); transform: rotate(45deg);
  }
  .pop-h { flex: none; display: flex; align-items: center; gap: 10px; padding: 12px 14px 8px; }
  .pop-h h3 { margin: 0; font-size: 15px; }
  .sp { flex: 1; }
  .tabs { flex: none; display: flex; gap: 6px; padding: 0 14px 10px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .chip { height: 24px; padding: 0 10px; border-radius: 12px; border: 1px solid var(--line); background: var(--card); font: inherit; font-size: 11px; color: var(--ink-2); cursor: pointer; }
  .chip.on { background: var(--ink); border-color: var(--ink); color: #fff; }
  .list { list-style: none; margin: 0; padding: 0; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  .item { display: grid; grid-template-columns: 30px 1fr; gap: 6px 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line-soft); }
  .item:last-child { border-bottom: 0; }
  .item .badge { width: 28px; height: 28px; font-size: 12px; }
  .mt { display: flex; flex-direction: column; min-width: 0; }
  .name { background: none; border: 0; padding: 0; font: inherit; font-weight: 600; color: var(--ink); text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name:hover { text-decoration: underline; }
  .sub { font-weight: 400; color: var(--muted); }
  .why { font-size: 12px; color: var(--ink-2); }
  .acts { grid-column: 2; display: flex; flex-wrap: wrap; gap: 6px; }
  .mini { height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--line); background: var(--card); font: inherit; font-size: 11.5px; font-weight: 600; color: var(--ink-2); cursor: pointer; }
  .mini.primary { background: var(--ink); color: #fff; border-color: var(--ink); }
  .mini.snooze { color: var(--muted); }
  .mini:disabled { opacity: 0.6; cursor: default; }
  .done-msg { padding: 22px 14px; text-align: center; color: var(--muted); font-size: 13px; }
  .pop-f { flex: none; padding: 9px 14px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); }
</style>
