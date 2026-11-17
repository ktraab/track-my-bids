<script lang="ts">
  import { app } from '$lib/state.svelte';
  import type { BidWithChildren } from '$lib/domain/types';

  let { data }: { data: BidWithChildren } = $props();
  let text = $state('');
  const R = 22;
  const C = 2 * Math.PI * R;
  const done = $derived(data.checklist.filter((c) => c.done).length);
  const total = $derived(data.checklist.length);
  const dash = $derived(total ? (done / total) * C : 0);

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    if (await app.addChecklistItem(data.bid.id, text)) text = '';
  }
</script>

<section class="card box">
  <div class="head">
    <svg width="56" height="56" viewBox="0 0 56 56" role="img" aria-label="{done} of {total} checklist items done">
      <circle cx="28" cy="28" r={R} fill="none" stroke="#e6eaf0" stroke-width="6" />
      <circle cx="28" cy="28" r={R} fill="none" stroke={data.bid.lineColor} stroke-width="6" stroke-linecap="round"
        stroke-dasharray="{dash} {C}" transform="rotate(-90 28 28)" />
      <text x="28" y="32" text-anchor="middle" font-size="13" font-weight="700" fill="#16202c">{done}/{total}</text>
    </svg>
    <h2>Checklist</h2>
  </div>
  <ul>
    {#each data.checklist as c, i (c.id)}
      <li class:done={c.done}>
        <label class="check">
          <input type="checkbox" checked={c.done} onchange={async (e) => { const el = e.currentTarget; if (!(await app.toggleChecklistItem(c.id, el.checked))) el.checked = c.done; }} />
          <span>{c.text}</span>
        </label>
        <div class="tools">
          <button class="icon" aria-label="Move up" disabled={i === 0} onclick={() => app.moveChecklistItem(c.id, -1)}>↑</button>
          <button class="icon" aria-label="Move down" disabled={i === total - 1} onclick={() => app.moveChecklistItem(c.id, 1)}>↓</button>
          <button class="icon" aria-label="Delete {c.text}" onclick={() => app.removeChecklistItem(c.id)}>✕</button>
        </div>
      </li>
    {/each}
  </ul>
  <form class="add" onsubmit={add}>
    <input bind:value={text} placeholder="Add checklist item" aria-label="New checklist item" style="flex: 1" />
    <button class="btn" type="submit">Add</button>
  </form>
</section>

<style>
  .head { display: flex; align-items: center; gap: 12px; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  li { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 0; border-top: 1px solid var(--line-soft); }
  li.done span { color: var(--muted); text-decoration: line-through; }
  .tools { display: flex; gap: 2px; opacity: 0.6; }
  li:hover .tools, li:focus-within .tools { opacity: 1; }
</style>
