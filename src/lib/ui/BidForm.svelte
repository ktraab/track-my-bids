<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '$lib/state.svelte';
  import type { Bid, ShipMethod } from '$lib/domain/types';
  import { AGENCY_TYPE_LABELS, METHOD_LABELS, SHIP_METHOD_LABELS, timezoneOptions } from '$lib/domain/labels';
  import { parseFundingYear, toErateCategory } from '$lib/domain/erate';

  let { bid, onDone }: { bid: Bid; onDone: () => void } = $props();
  const tzs = untrack(() => timezoneOptions(bid.timezone));

  // Snapshot of the bid at open time; saved explicitly.
  let f = $state(untrack(() => ({
    title: bid.title,
    bidNumber: bid.bidNumber ?? '',
    agencyName: bid.agencyName,
    agencyType: bid.agencyType,
    estValue: bid.estValue?.toString() ?? '',
    scope: bid.scope ?? '',
    submissionMethod: bid.submissionMethod,
    portalName: bid.portalName ?? '',
    portalUrl: bid.portalUrl ?? '',
    deliveryAddress: bid.deliveryAddress ?? '',
    copiesRequired: bid.copiesRequired?.toString() ?? '',
    notarizeRequired: bid.notarizeRequired,
    shipMethod: (bid.shipMethod ?? '') as ShipMethod | '',
    shipLeadBusinessDays: bid.shipLeadBusinessDays,
    timezone: bid.timezone,
    rfpUrl: bid.rfpUrl ?? '',
    notes: bid.notes ?? '',
    erate: bid.erate,
    erate470Number: bid.erate470Number ?? '',
    erateFundingYear: bid.erateFundingYear?.toString() ?? '',
    erateCategory: (bid.erateCategory?.toString() ?? '') as '' | '1' | '2',
  })));

  const txt = (s: string) => s.trim() || null;
  const num = (s: string) => {
    const n = Number(s.replace(/[^0-9.]/g, ''));
    return s.trim() && Number.isFinite(n) ? Math.round(n) : null;
  };

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!f.title.trim() || !f.agencyName.trim()) return;
    const ok = await app.updateBid(bid.id, {
      title: f.title.trim(),
      bidNumber: txt(f.bidNumber),
      agencyName: f.agencyName.trim(),
      agencyType: f.agencyType,
      estValue: num(f.estValue),
      scope: txt(f.scope),
      submissionMethod: f.submissionMethod,
      portalName: txt(f.portalName),
      portalUrl: txt(f.portalUrl),
      deliveryAddress: txt(f.deliveryAddress),
      copiesRequired: num(f.copiesRequired),
      notarizeRequired: f.notarizeRequired,
      shipMethod: f.shipMethod || null,
      shipLeadBusinessDays: Math.max(0, Math.round(Number(f.shipLeadBusinessDays) || 0)),
      timezone: f.timezone,
      rfpUrl: txt(f.rfpUrl),
      notes: txt(f.notes),
      erate: f.erate,
      erate470Number: f.erate ? txt(f.erate470Number) : null,
      erateFundingYear: f.erate ? parseFundingYear(f.erateFundingYear) : null,
      erateCategory: f.erate ? toErateCategory(f.erateCategory) : null,
    });
    if (ok) onDone();
  }
</script>

<form class="card box" onsubmit={save}>
  <h2>Edit details</h2>
  <div class="grid2">
    <label class="field"><span>Title *</span><input bind:value={f.title} required /></label>
    <label class="field"><span>Bid #</span><input bind:value={f.bidNumber} /></label>
  </div>
  <div class="grid3">
    <label class="field"><span>Agency *</span><input bind:value={f.agencyName} required /></label>
    <label class="field"><span>Agency type</span>
      <select bind:value={f.agencyType}>
        {#each Object.entries(AGENCY_TYPE_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
      </select>
    </label>
    <label class="field"><span>Est. value ($)</span><input bind:value={f.estValue} inputmode="numeric" /></label>
  </div>
  <label class="field"><span>Scope (products / services)</span><textarea bind:value={f.scope}></textarea></label>

  <div class="grid3">
    <label class="field"><span>Submission</span>
      <select bind:value={f.submissionMethod}>
        {#each Object.entries(METHOD_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
      </select>
    </label>
    <label class="field"><span>Agency timezone</span>
      <select bind:value={f.timezone}>
        {#each tzs as tz (tz)}<option value={tz}>{tz}</option>{/each}
      </select>
    </label>
    <label class="field"><span>RFP link</span><input bind:value={f.rfpUrl} type="url" placeholder="https://" /></label>
  </div>

  {#if f.submissionMethod === 'online'}
    <div class="grid2">
      <label class="field"><span>Portal name</span><input bind:value={f.portalName} placeholder="BidNet" /></label>
      <label class="field"><span>Portal URL</span><input bind:value={f.portalUrl} type="url" placeholder="https://" /></label>
    </div>
  {:else if f.submissionMethod === 'sealed'}
    <label class="field"><span>Delivery address</span><textarea bind:value={f.deliveryAddress}></textarea></label>
    <div class="grid3">
      <label class="field"><span>Copies required</span><input bind:value={f.copiesRequired} inputmode="numeric" /></label>
      <label class="field"><span>Ship method</span>
        <select bind:value={f.shipMethod}>
          <option value="">—</option>
          {#each Object.entries(SHIP_METHOD_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>
      <label class="field"><span>Ship lead (business days)</span><input type="number" min="0" max="10" bind:value={f.shipLeadBusinessDays} /></label>
    </div>
    <label class="check"><input type="checkbox" bind:checked={f.notarizeRequired} /> Notarization required</label>
  {/if}

  <label class="check"><input type="checkbox" bind:checked={f.erate} /> E-Rate bid (FCC Form 470)</label>
  {#if f.erate}
    <div class="grid3">
      <label class="field"><span>Form 470 #</span><input bind:value={f.erate470Number} inputmode="numeric" placeholder="270012345" /></label>
      <label class="field"><span>Funding year</span><input bind:value={f.erateFundingYear} inputmode="numeric" placeholder="2027" /></label>
      <label class="field"><span>Category</span>
        <select bind:value={f.erateCategory}>
          <option value="1">1</option><option value="2">2</option><option value="">Both</option>
        </select>
      </label>
    </div>
  {/if}

  <label class="field"><span>Notes</span><textarea bind:value={f.notes}></textarea></label>
  <p class="hint">Changing the timezone does not move existing milestone times.</p>
  <div class="actions">
    <button type="button" class="btn" onclick={onDone}>Cancel</button>
    <button type="submit" class="btn primary">Save</button>
  </div>
</form>

<style>
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
