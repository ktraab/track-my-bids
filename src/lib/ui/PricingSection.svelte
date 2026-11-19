<script lang="ts">
  import { app } from '$lib/state.svelte';
  import type { BidWithChildren, MarkupType, VendorQuote } from '$lib/domain/types';
  import { tick } from 'svelte';
  import {
    MARKUP_LABELS, MARKUP_TYPES, ROUNDING_LABELS, SELL_ROUNDINGS, parseAmount, parseQty, pricingOf, type LinePricing,
  } from '$lib/domain/pricing';
  import { formatMoney } from '$lib/domain/format';
  import { formatStopDate } from '$lib/domain/time';
  import { ageText } from '$lib/domain/rfq';

  /** `collapsible`: bid detail shows only an "Add pricing" button until the first line exists. */
  let { data, collapsible = false }: { data: BidWithChildren; collapsible?: boolean } = $props();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const b = $derived(data.bid);
  const p = $derived(pricingOf(data, app.pricingDefaults));
  const whole = $derived(b.pricingMode === 'whole');
  /** The quote's own markup, or the Settings default it falls back to. */
  const quoteMarkup = $derived(
    b.markupType && b.markupValue !== null
      ? { type: b.markupType, value: b.markupValue }
      : { type: app.pricingDefaults.markupType, value: app.pricingDefaults.markupValue });
  const totalLabel = $derived(b.kind === 'rfq' ? 'Quote total' : 'Our price');

  let opened = $state(false);
  // Latch: once a line has been seen the grid stays open, even if the last line is removed.
  $effect.pre(() => { if (p.lines.length > 0) opened = true; });
  const expanded = $derived(!collapsible || opened || p.lines.length > 0);
  let busy = $state(false);
  let gridEl = $state<HTMLElement | undefined>();
  let addDesc = $state<HTMLInputElement | undefined>();
  const QTY_ERR = 'Enter a quantity greater than 0';

  /** Focus an element as soon as it appears. */
  function focusOnMount(node: HTMLElement) { node.focus(); }
  let pasting = $state(false);
  let pasteText = $state('');
  let confirmRemove = $state<string | null>(null);
  let nl = $state({ qty: '1', description: '', partNo: '' });

  function vendorNote(v: VendorQuote): string {
    if (v.repliedAt) return `Replied ${formatStopDate(v.repliedAt, zone)}`;
    if (v.skipped) return 'Skipped';
    return `No reply · ${ageText(v.askedAt, app.nowMs)}`;
  }

  const shown = (n: number | null) => (n === null ? '' : String(n));

  /** Read an amount input. Blank → null. Anything else bad → put the old value back, say so, and return undefined. */
  function amountOf(el: HTMLInputElement, was: string): number | null | undefined {
    const a = parseAmount(el.value);
    if (a === undefined) {
      el.value = was;
      app.error = 'Enter an amount of 0 or more.';
    }
    return a;
  }

  async function setCost(el: HTMLInputElement, v: VendorQuote, l: LinePricing, k: number) {
    const was = shown(l.costs[k]);
    const a = amountOf(el, was);
    if (a === undefined) return;
    if (a === l.costs[k]) { el.value = was; return; }
    if (!(await app.setLinePrice(v.id, l.line.id, a))) el.value = was;
  }

  async function setQty(el: HTMLInputElement, l: LinePricing) {
    const n = parseQty(el.value);
    if (n === null || n === undefined || n <= 0) {
      el.value = String(l.line.qty);
      app.error = QTY_ERR;
      return;
    }
    if (n !== l.line.qty && !(await app.updateLine(l.line.id, { qty: n }))) el.value = String(l.line.qty);
  }

  async function setDescription(el: HTMLInputElement, l: LinePricing) {
    const v = el.value.trim();
    if (v === l.line.description) return;
    if (!v) {
      el.value = l.line.description;
      app.error = 'Description is required';
      return;
    }
    if (!(await app.updateLine(l.line.id, { description: v }))) el.value = l.line.description;
  }

  async function setPartNo(el: HTMLInputElement, l: LinePricing) {
    const v = el.value.trim();
    if (v === (l.line.partNo ?? '')) return;
    if (!(await app.updateLine(l.line.id, { partNo: v || null }))) el.value = l.line.partNo ?? '';
  }

  /** Changing a line's markup drops its fixed sell price (the markup drives the price again). */
  async function setLineMarkupType(el: HTMLSelectElement, l: LinePricing) {
    const t = el.value;
    const ok = await app.updateLine(l.line.id, t === 'default'
      ? { markupType: null, markupValue: null, sellOverride: null }
      : { markupType: t as MarkupType, markupValue: l.markup.value, sellOverride: null });
    if (!ok) el.value = l.markupSource === 'line' ? l.markup.type : 'default';
  }

  async function setLineMarkupValue(el: HTMLInputElement, l: LinePricing) {
    const was = String(l.markup.value);
    const a = amountOf(el, was);
    if (a === undefined) return;
    if (a === null || a === l.markup.value) { el.value = was; return; }
    if (!(await app.updateLine(l.line.id, { markupValue: a, sellOverride: null }))) el.value = was;
  }

  const sellShown = (l: LinePricing) =>
    l.unitSell !== null ? l.unitSell.toFixed(2) : l.line.sellOverride !== null ? l.line.sellOverride.toFixed(2) : '';

  /** Typing a sell price fixes it (markup shown as derived); clearing it goes back to cost + markup. */
  async function setSell(el: HTMLInputElement, l: LinePricing) {
    const was = sellShown(l);
    const a = amountOf(el, was);
    if (a === undefined) return;
    if (a === null && l.line.sellOverride === null) { el.value = was; return; }
    if (a !== null && ((l.line.sellOverride === null && a === l.unitSell) || a === l.line.sellOverride)) { el.value = was; return; }
    if (!(await app.updateLine(l.line.id, { sellOverride: a }))) el.value = was;
  }

  async function setQuoteMarkupType(el: HTMLSelectElement) {
    if (!(await app.setQuoteMarkup(b.id, { type: el.value as MarkupType, value: quoteMarkup.value }))) el.value = quoteMarkup.type;
  }

  async function setQuoteMarkupValue(el: HTMLInputElement) {
    const was = String(quoteMarkup.value);
    const a = amountOf(el, was);
    if (a === undefined) return;
    if (a === null || a === quoteMarkup.value) { el.value = was; return; }
    if (!(await app.setQuoteMarkup(b.id, { type: quoteMarkup.type, value: a }))) el.value = was;
  }

  async function setRounding(el: HTMLSelectElement) {
    if (!(await app.setSellRounding(b.id, Number(el.value)))) el.value = String(b.sellRounding);
  }

  async function addLine(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    const qty = parseQty(nl.qty);
    if (!nl.description.trim()) return;
    if (qty === null || qty === undefined || qty <= 0) { app.error = QTY_ERR; return; }
    busy = true;
    try {
      if (await app.addLine(b.id, { qty, description: nl.description, partNo: nl.partNo || null })) {
        nl = { qty: '1', description: '', partNo: '' };
      }
    } finally { busy = false; }
  }

  async function paste() {
    if (busy) return;
    busy = true;
    try {
      if (await app.pasteLines(b.id, pasteText)) {
        pasteText = '';
        pasting = false;
      }
    } finally { busy = false; }
  }

  async function pickVendor(el: HTMLInputElement, l: LinePricing, v: VendorQuote) {
    const prev = l.chosenVendorId;
    if (!(await app.updateLine(l.line.id, { chosenVendorId: v.id }))) {
      el.checked = false;
      if (prev) {
        const back = el.form?.querySelector<HTMLInputElement>(`input[type=radio][data-v="${l.line.id}:${prev}"]`)
          ?? gridEl?.querySelector<HTMLInputElement>(`input[type=radio][data-v="${l.line.id}:${prev}"]`);
        if (back) back.checked = true;
      }
    }
  }

  async function remove(id: string) {
    if (await app.removeLine(id)) {
      confirmRemove = null;
      await tick();
      addDesc?.focus();
    }
  }

  async function keep(id: string) {
    confirmRemove = null;
    await tick();
    gridEl?.querySelector<HTMLInputElement>(`input[data-qty="${id}"]`)?.focus();
  }

  async function openPricing() {
    opened = true;
    await tick();
    gridEl?.querySelector<HTMLElement>('button, select, input')?.focus();
  }
</script>

{#if !expanded}
  <section class="card box">
    <h2>Pricing</h2>
    <p class="hint">Price it line by line from your vendors’ quotes, with automatic markup.</p>
    <div><button class="btn" onclick={openPricing}>Add pricing</button></div>
  </section>
{:else}
  <section class="card pg" aria-label="Pricing" bind:this={gridEl}>
    <div class="bar">
      <h2>Pricing</h2>
      <div class="ctl"><span class="lbl">Buy from</span>
        <span class="segctl" role="group" aria-label="Buy from">
          <button class="seg-btn" class:on={whole} aria-pressed={whole} onclick={() => !whole && app.setPricingMode(b.id, 'whole')}>Whole quote</button>
          <button class="seg-btn" class:on={!whole} aria-pressed={!whole} onclick={() => whole && app.setPricingMode(b.id, 'per_line')}>Per line</button>
        </span>
      </div>
      <div class="ctl"><span class="lbl">Default markup</span>
        <span class="mk">
          <select value={quoteMarkup.type} onchange={(e) => setQuoteMarkupType(e.currentTarget)} aria-label="Default markup type">
            {#each MARKUP_TYPES as t (t)}<option value={t}>{MARKUP_LABELS[t]}</option>{/each}
          </select>
          <input class="num-in" inputmode="decimal" value={String(quoteMarkup.value)} onchange={(e) => setQuoteMarkupValue(e.currentTarget)} aria-label="Default markup amount" />
        </span>
      </div>
      <div class="ctl"><span class="lbl">Round sell price</span>
        <select class="sel" value={String(b.sellRounding)} onchange={(e) => setRounding(e.currentTarget)} aria-label="Round sell price">
          {#each SELL_ROUNDINGS as r (r)}<option value={String(r)}>{ROUNDING_LABELS[String(r)]}</option>{/each}
        </select>
      </div>
      {#if whole && !p.autoWhole}
        <button class="mini" onclick={() => app.setWholeVendor(b.id, null)}>Use lowest total</button>
      {/if}
      <span class="spacer"></span>
      <button class="mini" aria-expanded={pasting} onclick={() => (pasting = !pasting)}>Paste lines from Excel</button>
    </div>

    {#if pasting}
      <div class="paste">
        <span class="hint"><b>1.</b> Lay out your sheet with the columns in this order:</span>
        <div class="paste-example" role="table" aria-label="Example sheet layout">
          <div class="pe-row pe-head" role="row">
            <span role="columnheader">Qty</span><span role="columnheader">Description</span><span role="columnheader">Part #</span>
            {#each p.vendors as v (v.id)}<span role="columnheader" class="pe-price">{v.vendorName} cost</span>{/each}
          </div>
          <div class="pe-row" role="row">
            <span role="cell">10</span><span role="cell">Laptop 14"</span><span role="cell">LT-14</span>
            {#each p.vendors as v, k (v.id)}<span role="cell" class="pe-price">{(899 + k * 12).toFixed(2)}</span>{/each}
          </div>
        </div>
        <ul class="hint paste-notes">
          <li>A header row is fine; it's skipped. Rows with no description are skipped.</li>
          <li>Part # can be left blank, but keep the column so the prices line up.</li>
          {#if p.vendors.length}
            <li>Price columns are optional: one <b>unit cost</b> per vendor, in the order shown above. Leave a cell blank if that vendor didn't price the line.</li>
          {:else}
            <li>Add vendors first if you also want to paste their prices (one unit-cost column per vendor).</li>
          {/if}
          <li>Qty like "2 EA" or "1,200" works. Prices can include $ and commas.</li>
        </ul>
        <span class="hint"><b>2.</b> In Excel, select the rows (just the cells, not whole columns) and press <kbd>⌘C</kbd>. <b>3.</b> Click the box below and press <kbd>⌘V</kbd>.</span>
        <textarea bind:value={pasteText} rows="4" aria-label="Rows pasted from Excel" placeholder="Paste here (⌘V)"></textarea>
        <div class="row">
          <button class="mini primary" onclick={paste} disabled={busy || !pasteText.trim()}>Add lines</button>
          <button class="mini" onclick={() => { pasting = false; pasteText = ''; }}>Cancel</button>
        </div>
      </div>
    {/if}

    {#if p.lines.length}
      <div class="grid-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th>Qty</th>
              <th>Item</th>
              {#each p.vendors as v (v.id)}<th class="v">{v.vendorName}<small>{vendorNote(v)}</small></th>{/each}
              <th>Markup</th>
              <th class="num">Sell / unit</th>
              <th class="num">Line total</th>
              <th><span class="sr">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {#each p.lines as l (l.line.id)}
              <tr>
                <td class="qty">
                  <input class="num-in sm" inputmode="decimal" data-qty={l.line.id} value={String(l.line.qty)} onchange={(e) => setQty(e.currentTarget, l)} aria-label="Quantity for {l.line.description}" />
                </td>
                <td class="desc">
                  <input class="txt" value={l.line.description} onchange={(e) => setDescription(e.currentTarget, l)} aria-label="Description" />
                  <input class="txt part" value={l.line.partNo ?? ''} placeholder="Part #" onchange={(e) => setPartNo(e.currentTarget, l)} aria-label="Part number for {l.line.description}" />
                  {#if !whole && l.line.chosenVendorId}
                    <button class="linkish small" onclick={() => app.updateLine(l.line.id, { chosenVendorId: null })}>Use cheapest</button>
                  {/if}
                </td>
                {#each p.vendors as v, k (v.id)}
                  {@const c = l.costs[k]}
                  {@const chosen = c !== null && l.chosenVendorId === v.id}
                  <td class="cell" class:low={c !== null && c === l.lowestCost} class:chosen class:dim={whole && c !== null && !chosen} class:missing={c === null}>
                    <span class="cellin">
                      {#if !whole && c !== null}
                        <input type="radio" name="pick-{l.line.id}" checked={chosen} data-v="{l.line.id}:{v.id}" onchange={(e) => pickVendor(e.currentTarget, l, v)} aria-label="Buy {l.line.description} from {v.vendorName}" />
                      {/if}
                      <input class="num-in sm" inputmode="decimal" value={shown(c)} placeholder="No price" onchange={(e) => setCost(e.currentTarget, v, l, k)} aria-label="{v.vendorName} unit price for {l.line.description}" />
                    </span>
                  </td>
                {/each}
                <td>
                  <span class="mk" class:inherit={l.markupSource !== 'line'}>
                    <select value={l.markupSource === 'line' ? l.markup.type : 'default'} onchange={(e) => setLineMarkupType(e.currentTarget, l)} aria-label="Markup type for {l.line.description}">
                      <option value="default">default</option>
                      {#each MARKUP_TYPES as t (t)}<option value={t}>{MARKUP_LABELS[t]}</option>{/each}
                    </select>
                    <input class="num-in sm" inputmode="decimal" value={String(l.markup.value)} disabled={l.markupSource !== 'line'} onchange={(e) => setLineMarkupValue(e.currentTarget, l)} aria-label="Markup amount for {l.line.description}" />
                  </span>
                  {#if l.line.sellOverride !== null}
                    <small class="derived">{l.derivedPct === null ? 'fixed price' : `fixed price · ${l.derivedPct.toFixed(1)}% markup`}</small>
                  {/if}
                </td>
                <td class="num">
                  <input class="num-in" class:override={l.line.sellOverride !== null} inputmode="decimal" value={sellShown(l)} placeholder="—" disabled={l.unitCost === null} title={l.unitCost === null ? 'Needs a vendor cost first' : undefined} onchange={(e) => setSell(e.currentTarget, l)} aria-label="Sell price for {l.line.description}" />
                </td>
                <td class="sell">{#if l.flagged}<span class="late-text">No price</span>{:else}{formatMoney(l.lineTotal)}{/if}</td>
                <td class="rm">
                  {#if confirmRemove === l.line.id}
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <span role="group" aria-label="Confirm remove" onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); keep(l.line.id); } }}>
                      <button class="mini danger" use:focusOnMount onclick={() => remove(l.line.id)}>Remove</button>
                      <button class="mini" onclick={() => keep(l.line.id)}>Keep</button>
                    </span>
                  {:else}
                    <button class="icon" aria-label="Remove {l.line.description}" onclick={() => (confirmRemove = l.line.id)}>✕</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
          {#if p.vendors.length}
            <tfoot>
              <tr class="tot">
                <td></td>
                <td>Vendor total</td>
                {#each p.vendors as v, k (v.id)}
                  {@const t = p.totals[k]}
                  <td class="cell" class:chosen={whole && p.wholeVendorId === v.id} class:missing={t.total === null}>
                    {#if t.total === null}
                      Missing lines
                    {:else if whole}
                      <button class="pick" aria-pressed={p.wholeVendorId === v.id} onclick={() => app.setWholeVendor(b.id, v.id)} aria-label="Buy the whole quote from {v.vendorName}">{formatMoney(t.total)}</button>
                    {:else}
                      {formatMoney(t.total)}
                    {/if}
                  </td>
                {/each}
                <td></td><td></td><td></td><td></td>
              </tr>
            </tfoot>
          {/if}
        </table>
      </div>
      {#if !p.vendors.length}
        <p class="hint pad">Add vendors in the Vendors section to enter their prices.</p>
      {/if}
    {:else}
      <p class="hint pad">No lines yet. Add one below, or paste rows from Excel.</p>
    {/if}

    <form class="add pad" onsubmit={addLine}>
      <input class="q" bind:value={nl.qty} inputmode="decimal" aria-label="New line quantity" />
      <input class="d" bind:this={addDesc} bind:value={nl.description} placeholder="Description" aria-label="New line description" />
      <input class="pn" bind:value={nl.partNo} placeholder="Part #" aria-label="New line part number" />
      <button class="btn" type="submit" disabled={busy || !nl.description.trim()}>Add line</button>
    </form>

    {#if p.lines.length}
      <div class="summary">
        <div><span>Buying from</span><b>{p.summary.vendorsUsed.join(' + ') || '—'}</b></div>
        <div><span>Cost</span><b>{formatMoney(p.summary.cost)}</b></div>
        <div><span>Markup</span><b>{formatMoney(p.summary.markup)}</b></div>
        <div><span>Margin</span><b>{p.summary.marginPct === null ? '—' : `${p.summary.marginPct.toFixed(1)}%`}</b></div>
        <div>
          <span>{totalLabel}{#if p.summary.flagged} <em class="late-text">({p.summary.flagged} line{p.summary.flagged === 1 ? '' : 's'} not priced, left out)</em>{/if}</span>
          <b class="big">{formatMoney(p.summary.total)}</b>
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .pg { display: flex; flex-direction: column; overflow: hidden; }
  .bar { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--line); }
  .ctl { display: flex; align-items: center; gap: 8px; }
  .lbl { font-size: 12px; font-weight: 600; color: var(--muted); }
  .spacer { flex: 1; }
  .pad { padding: 12px 18px; }
  .segctl { display: inline-flex; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .seg-btn { height: 28px; padding: 0 12px; border: 0; background: var(--card); font-size: 12px; font-weight: 600; color: var(--ink-2); }
  .seg-btn + .seg-btn { border-left: 1px solid var(--line); }
  .seg-btn.on { background: var(--ink); color: #fff; }
  .num-in { width: 84px; height: 28px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; font-size: 13px; text-align: right; background: #fff; font-variant-numeric: tabular-nums; }
  .num-in.sm { width: 72px; height: 26px; font-size: 12px; }
  .num-in.override { border-color: var(--ink-2); font-weight: 700; }
  .num-in:disabled { color: var(--muted); border-style: dashed; background: none; }
  .mk { display: inline-flex; align-items: center; gap: 4px; }
  .mk select, .sel { height: 28px; border: 1px solid var(--line); border-radius: 8px; font-size: 12px; background: #fff; padding: 0 4px; }
  .mini { height: 28px; padding: 0 12px; border-radius: 14px; border: 1px solid var(--line); background: var(--card); font-size: 12px; font-weight: 600; color: var(--ink-2); }
  .mini.primary { background: var(--ink); color: #fff; border-color: var(--ink); }
  .mini.danger { color: var(--red); }
  .row { display: flex; gap: 8px; align-items: center; }
  .paste { display: flex; flex-direction: column; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--line); background: var(--line-soft); }
  .paste-example { display: inline-flex; flex-direction: column; align-self: flex-start; max-width: 100%; overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; background: #fff; font: 11.5px/1.3 ui-monospace, Menlo, monospace; }
  .pe-row { display: flex; }
  .pe-row span { flex: 0 0 auto; min-width: 64px; padding: 4px 8px; border-right: 1px solid var(--line); white-space: nowrap; }
  .pe-row span:last-child { border-right: 0; }
  .pe-head { background: var(--line-soft); font-weight: 600; border-bottom: 1px solid var(--line); }
  .pe-price { text-align: right; }
  .paste-notes { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; }
  .paste kbd { font: 11px ui-monospace, Menlo, monospace; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; background: #fff; }
  .paste textarea { min-height: 70px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font: 12px/1.4 ui-monospace, Menlo, monospace; background: #fff; resize: vertical; }
  .grid-wrap { overflow-x: auto; }
  .grid { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
  .grid th { text-align: left; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .grid th.v, .grid th.num { text-align: right; }
  .grid th.v small { display: block; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--muted); }
  .grid td { padding: 8px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
  .grid td.num { text-align: right; }
  .qty { width: 72px; }
  .desc { min-width: 200px; }
  .txt { display: block; width: 100%; border: 1px solid transparent; border-radius: 6px; padding: 2px 6px; background: none; font-weight: 600; }
  .txt.part { font-weight: 400; font-size: 11px; color: var(--muted); }
  .txt:hover, .txt:focus { border-color: var(--line); background: #fff; }
  .linkish.small { font-size: 11px; margin-left: 6px; }
  .cell { text-align: right; border-left: 1px solid var(--line-soft); white-space: nowrap; }
  .cellin { display: inline-flex; align-items: center; gap: 6px; }
  .cell.low .num-in { color: var(--cust-ink); font-weight: 600; }
  .cell.chosen { background: var(--cust-soft); box-shadow: inset 0 0 0 2px var(--cust); }
  .cell.chosen .num-in { font-weight: 700; color: var(--ink); }
  .cell.dim .num-in { color: var(--past); }
  .cell.missing .num-in::placeholder { color: var(--red); }
  .derived { display: block; margin-top: 2px; font-size: 11px; color: var(--muted); }
  .sell { text-align: right; font-weight: 600; border-left: 1px solid var(--line); white-space: nowrap; }
  .rm { white-space: nowrap; text-align: right; }
  .tot td { border-top: 2px solid var(--line); font-weight: 700; background: var(--line-soft); }
  .tot td.cell.missing { color: var(--red); font-size: 12px; }
  .tot td.cell.chosen { background: var(--cust-soft); }
  .pick { border: 0; background: none; padding: 2px 4px; border-radius: 6px; font-weight: 700; text-decoration: underline dotted; }
  .pick[aria-pressed='true'] { text-decoration: none; }
  .add .q { width: 72px; }
  .add .d { flex: 1 1 260px; }
  .add .pn { width: 140px; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); border-top: 1px solid var(--line); }
  .summary > div { padding: 14px 18px; display: flex; flex-direction: column; gap: 2px; border-right: 1px solid var(--line-soft); }
  .summary > div:last-child { border-right: 0; }
  .summary b { font-family: var(--display); font-size: 20px; font-variant-numeric: tabular-nums; }
  .summary b.big { font-size: 24px; }
  .summary span { font-size: 12px; color: var(--muted); }
  .summary em { font-style: normal; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
