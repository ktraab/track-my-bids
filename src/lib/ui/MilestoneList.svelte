<script lang="ts">
  import { app } from '$lib/state.svelte';
  import CalendarMenu from './CalendarMenu.svelte';
  import type { BidWithChildren, MilestoneType } from '$lib/domain/types';
  import { MILESTONE_TYPE_LABELS, milestoneTitle } from '$lib/domain/labels';
  import { formatCountdown, isoToLocalInput, localToIso, toMs } from '$lib/domain/time';

  let { data }: { data: BidWithChildren } = $props();
  const tz = $derived(data.bid.timezone);
  const addable = (Object.entries(MILESTONE_TYPE_LABELS) as [MilestoneType, string][]).filter(([k]) => k !== 'due');

  let type = $state<MilestoneType>('qa_deadline');
  let label = $state('');
  let atLocal = $state('');
  let location = $state('');
  let mandatory = $state(false);

  /** Render helpers never throw: bad data shows a placeholder instead of crashing the view. */
  function localValue(iso: string): string {
    try { return isoToLocalInput(iso, tz); } catch { return ''; }
  }
  function countdown(iso: string): string {
    try {
      const ms = toMs(iso);
      return ms >= app.nowMs ? formatCountdown(app.nowMs, ms) : 'past';
    } catch { return '—'; }
  }
  function upcoming(m: { done: boolean; at: string }): boolean {
    try { return !m.done && toMs(m.at) >= app.nowMs; } catch { return false; }
  }
  function safeIso(local: string): string | null {
    try { return localToIso(local, tz); } catch (err) {
      app.error = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!atLocal) return;
    const at = safeIso(atLocal);
    if (!at) return;
    const ok = await app.addMilestone({
      bidId: data.bid.id,
      type,
      label: type === 'custom' ? label : null,
      at,
      location: location.trim() || null,
      mandatory,
    });
    if (ok) { label = ''; atLocal = ''; location = ''; mandatory = false; }
  }

  async function saveAt(id: string, el: HTMLInputElement, stored: string) {
    const value = el.value;
    if (!value || !el.validity.valid || value === stored) { el.value = stored; return; }
    const at = safeIso(value);
    if (!at) { el.value = stored; return; }
    if (!(await app.updateMilestone(id, { at }))) el.value = stored;
  }
  async function saveLoc(id: string, el: HTMLInputElement, stored: string | null) {
    const value = el.value.trim();
    if (value === (stored ?? '')) { el.value = stored ?? ''; return; }
    if (!(await app.updateMilestone(id, { location: value || null }))) el.value = stored ?? '';
  }
  function enterBlur(e: KeyboardEvent) {
    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
  }
</script>

<section class="card box">
  <h2>Milestones</h2>
  <ul>
    {#each data.milestones as m (m.id)}
      {@const title = milestoneTitle(m)}
      <li class:done={m.done}>
        <input type="checkbox" checked={m.done} aria-label="Mark {title} done"
          onchange={async (e) => { const el = e.currentTarget; if (!(await app.updateMilestone(m.id, { done: el.checked }))) el.checked = m.done; }} />
        <div class="what">
          <div class="name"><strong>{title}</strong>{#if m.mandatory}<span class="tag">MANDATORY</span>{/if}</div>
          <input class="loc" value={m.location ?? ''} placeholder="Location or meeting link" aria-label="{title} location"
            onblur={(e) => saveLoc(m.id, e.currentTarget, m.location)} onkeydown={enterBlur} />
        </div>
        <input type="datetime-local" value={localValue(m.at)} aria-label="{title} date and time"
          onblur={(e) => saveAt(m.id, e.currentTarget, localValue(m.at))} onkeydown={enterBlur} />
        <span class="cd">{countdown(m.at)}</span>
        <label class="check small">
          <input type="checkbox" checked={m.mandatory}
            onchange={async (e) => { const el = e.currentTarget; if (!(await app.updateMilestone(m.id, { mandatory: el.checked }))) el.checked = m.mandatory; }} />
          Mandatory
        </label>
        {#if upcoming(m)}
          <CalendarMenu bidId={data.bid.id} stopId={m.id} />
        {:else}
          <span class="icon-spacer"></span>
        {/if}
        {#if m.type !== 'due'}
          <button class="icon" aria-label="Delete {title}" onclick={() => app.removeMilestone(m.id)}>✕</button>
        {:else}
          <span class="icon-spacer"></span>
        {/if}
      </li>
    {/each}
  </ul>

  <form class="add" onsubmit={add}>
    <select bind:value={type} aria-label="Milestone type">
      {#each addable as [value, text] (value)}<option {value}>{text}</option>{/each}
    </select>
    {#if type === 'custom'}
      <input bind:value={label} placeholder="Label (e.g. Board vote)" aria-label="Custom label" />
    {/if}
    <input type="datetime-local" bind:value={atLocal} aria-label="New milestone date and time" />
    <input bind:value={location} placeholder="Location (optional)" aria-label="New milestone location" />
    <label class="check small"><input type="checkbox" bind:checked={mandatory} /> Mandatory</label>
    <button class="btn" type="submit" disabled={!atLocal || (type === 'custom' && !label.trim())}>Add</button>
  </form>
  <p class="hint">Times are in the agency's timezone ({tz}).</p>
</section>

<style>
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line-soft); flex-wrap: wrap; }
  li.done .name strong { color: var(--muted); text-decoration: line-through; }
  .what { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .name { display: flex; gap: 8px; align-items: center; }
  .loc { border: 0; border-bottom: 1px dashed var(--line); padding: 2px 0; font-size: 12px; color: var(--ink-2); background: none; }
  li input[type='datetime-local'] { height: 34px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px; }
  .cd { width: 80px; text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-2); }
  .small { font-size: 12px; color: var(--ink-2); }
  .icon-spacer { width: 32px; }
</style>
