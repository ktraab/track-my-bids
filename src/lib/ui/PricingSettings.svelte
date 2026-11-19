<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { MARKUP_LABELS, MARKUP_TYPES, parseAmount } from '$lib/domain/pricing';
  import type { MarkupType } from '$lib/domain/types';

  let type = $state<MarkupType>(untrack(() => app.pricingDefaults.markupType));
  let value = $state(untrack(() => String(app.pricingDefaults.markupValue)));
  let saving = $state(false);

  const parsed = $derived(parseAmount(value));
  const bad = $derived(typeof parsed !== 'number');
  const dirty = $derived(type !== app.pricingDefaults.markupType || parsed !== app.pricingDefaults.markupValue);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (bad || typeof parsed !== 'number') return;
    saving = true;
    await app.savePricingDefaults({ markupType: type, markupValue: parsed });
    saving = false;
  }
</script>

<form class="col" onsubmit={save}>
  <p class="hint">The markup a quote or bid starts with when you add its first price line. Change it per quote, or per line, in the pricing grid.</p>
  <div class="inline">
    <label class="field"><span>Default markup</span>
      <select bind:value={type} aria-label="Markup type">
        {#each MARKUP_TYPES as t (t)}<option value={t}>{MARKUP_LABELS[t]}</option>{/each}
      </select>
    </label>
    <label class="field"><span>Amount</span>
      <input bind:value={value} inputmode="decimal" aria-invalid={bad} aria-label="Markup amount" />
    </label>
  </div>
  {#if bad}<p class="err" role="alert">Enter an amount of 0 or more.</p>{/if}
  <div class="actions">
    <button class="btn primary" type="submit" disabled={!dirty || bad || saving}>Save default markup</button>
  </div>
</form>

<style>
  .col { display: flex; flex-direction: column; gap: 12px; }
  .inline { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .inline input { width: 120px; }
  .actions { display: flex; justify-content: flex-end; }
  .err { margin: 0; color: var(--red); font-size: 13px; }
</style>
