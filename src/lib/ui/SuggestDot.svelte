<script lang="ts">
  import { DateTime } from 'luxon';
  import type { FieldSource } from '$lib/domain/docFill';
  import type { Candidate } from '$lib/domain/extract';

  /**
   * Marks a pre-filled input: a dot whose tooltip shows where the value came from, plus a compact
   * dropdown of the other values the document offered (when there are several).
   */
  let {
    source,
    label,
    value,
    formValue = (c: Candidate) => c.value,
    onpick,
  }: {
    source: FieldSource | undefined;
    /** The input's name, for screen readers ("Other values for Due date"). */
    label: string;
    /** The input's current value: the dropdown shows which candidate it is (none when typed / changed). */
    value?: unknown;
    /** A candidate as the input would hold it (e.g. category 'both' → ''); null when it can't. */
    formValue?: (c: Candidate) => unknown;
    onpick?: (c: Candidate) => void;
  } = $props();

  const candidates = $derived(source?.kind === 'doc' ? source.candidates : []);
  /** Which candidate the input holds now; -1 = typed or otherwise changed. */
  const picked = $derived(candidates.findIndex((c) => { const v = formValue(c); return v !== null && v === value; }));

  const NO_TIME = ' (no time in document — 5:00 PM assumed)';

  /** p.1 — "…proposals due Tuesday, March 3, 2026 at 2:00 PM…" (or the calculation note). */
  function where(c: Candidate): string {
    const noTime = c.hasTime === false ? NO_TIME : '';
    if (c.note) return `p.${c.page} — ${c.note}${noTime}`;
    const t = c.text.length > 140 ? `${c.text.slice(0, 137)}…` : c.text;
    return `p.${c.page} — “${t}”${c.learned ? ' (learned label)' : ''}${noTime}`;
  }

  /** Dates read better as "Tue Mar 3, 2:00 PM"; everything else as found. */
  function show(c: Candidate): string {
    const d = DateTime.fromISO(c.value);
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(c.value) && d.isValid
      ? d.toFormat(c.hasTime === false ? 'ccc LLL d, yyyy (no time)' : 'ccc LLL d, yyyy h:mm a')
      : c.value;
  }

  const tip = $derived(
    source?.kind === 'memory' ? `From your last ${source.agencyName} bid`
      : !candidates.length ? ''
      : picked >= 0 ? where(candidates[picked])
      : `Changed from the document’s ${show(candidates[0])} — ${where(candidates[0])}`,
  );
</script>

{#if source}
  <span class="sug">
    <button type="button" class="dot" class:memory={source.kind === 'memory'} aria-label="{label}: {tip}">
      <span class="tip" role="tooltip">{tip}</span>
    </button>
    {#if candidates.length > 1}
      <select
        aria-label="Other values found for {label}"
        value={String(picked)}
        onchange={(e) => { const c = candidates[Number(e.currentTarget.value)]; if (c) onpick?.(c); }}
      >
        {#if picked < 0}<option value="-1" disabled>Your value</option>{/if}
        <!-- WKWebView's native list ignores option titles: the page goes in the text. -->
        {#each candidates as c, i (i)}<option value={String(i)} title={where(c)}>{show(c)} · p.{c.page}</option>{/each}
      </select>
    {/if}
  </span>
{/if}

<style>
  .sug { position: absolute; top: 0; right: 0; display: inline-flex; align-items: center; gap: 6px; }
  .dot {
    position: relative; display: inline-block; width: 9px; height: 9px; padding: 0; border: 0; border-radius: 50%;
    background: #2f6fd1; cursor: help; outline-offset: 2px;
  }
  .dot.memory { background: transparent; border: 2px solid #8a5a00; }
  .tip {
    display: none; position: absolute; right: -6px; top: 16px; z-index: 60; width: max-content; max-width: 340px;
    padding: 8px 10px; background: #fff; border: 1px solid var(--line); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(22, 32, 44, 0.15); color: var(--ink); font-size: 12px; font-weight: 400; line-height: 1.4;
    white-space: normal;
  }
  .dot:hover .tip, .dot:focus-visible .tip { display: block; }
  select { height: 22px; max-width: 190px; padding: 0 4px; font-size: 12px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
</style>
