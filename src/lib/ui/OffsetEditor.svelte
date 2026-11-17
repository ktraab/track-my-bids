<script lang="ts">
  import { addOffset, formatOffset, toMinutes, type OffsetUnit } from '$lib/domain/offsets';

  let { label, offsets = $bindable() }: { label: string; offsets: number[] } = $props();
  let amount = $state<number | null>(null);
  let unit = $state<OffsetUnit>('days');
  const minutes = $derived(amount == null ? null : toMinutes(amount, unit));

  function add() {
    if (minutes == null) return;
    offsets = addOffset(offsets, minutes);
    amount = null;
  }
</script>

<div class="row">
  <div class="label">{label}</div>
  <div class="chips">
    {#each offsets as o (o)}
      <span class="chip">{formatOffset(o)} before
        <button type="button" class="x" aria-label="Remove {formatOffset(o)} reminder for {label}" onclick={() => (offsets = offsets.filter((x) => x !== o))}>✕</button>
      </span>
    {:else}
      <span class="none">No reminders</span>
    {/each}
  </div>
  <div class="add">
    <input type="number" min="1" step="1" bind:value={amount} aria-label="Amount for new {label} reminder" />
    <select bind:value={unit} aria-label="Unit for new {label} reminder">
      <option value="minutes">min</option><option value="hours">hours</option><option value="days">days</option>
    </select>
    <button type="button" class="btn small" onclick={add} disabled={minutes == null}>Add</button>
  </div>
</div>

<style>
  .row { display: grid; grid-template-columns: 160px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line-soft); }
  .label { font-weight: 600; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 10px; border-radius: 14px; background: var(--bg); font-size: 13px; }
  .x { border: 0; background: none; width: 22px; height: 22px; border-radius: 11px; color: var(--muted); }
  .x:hover { background: #fff; color: var(--ink); }
  .none { color: var(--muted); font-size: 13px; }
  .add { display: flex; gap: 6px; }
  .add input { width: 64px; height: 32px; border: 1px solid var(--line); border-radius: 8px; padding: 0 6px; }
  .add select { height: 32px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
  .btn.small { height: 32px; padding: 0 12px; font-size: 13px; }
  @media (max-width: 860px) { .row { grid-template-columns: 1fr; } }
</style>
