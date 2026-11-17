<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { AGENCY_TYPE_LABELS, METHOD_LABELS, timezoneOptions } from '$lib/domain/labels';
  import type { AgencyType, Method } from '$lib/domain/types';

  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzs = timezoneOptions(systemTz);

  let dialog: HTMLDialogElement | undefined = $state();
  let title = $state('');
  let agencyName = $state('');
  let agencyType = $state<AgencyType>('k12');
  let method = $state<Method>('online');
  let dueAtLocal = $state('');
  let timezone = $state(systemTz);
  let estValue = $state('');
  let bidNumber = $state('');
  let saving = $state(false);

  const valid = $derived(!!title.trim() && !!agencyName.trim() && !!dueAtLocal);

  $effect(() => {
    dialog?.showModal();
  });

  function parseMoney(s: string): number | null {
    const n = Number(s.replace(/[^0-9.]/g, ''));
    return s.trim() && Number.isFinite(n) ? Math.round(n) : null;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    saving = true;
    const id = await app.createBid({
      title: title.trim(),
      agencyName: agencyName.trim(),
      agencyType,
      submissionMethod: method,
      dueAtLocal,
      timezone,
      estValue: parseMoney(estValue),
      bidNumber: bidNumber.trim() || null,
    });
    saving = false;
    if (id) dialog?.close();
  }
</script>

<dialog bind:this={dialog} onclose={() => (app.quickAddOpen = false)} aria-labelledby="qa-title">
  <form onsubmit={save}>
    <h2 id="qa-title">New bid</h2>
    <label class="field">
      <span>Bid title *</span>
      <input bind:value={title} placeholder="Student Chromebooks" required />
    </label>
    <label class="field">
      <span>Agency *</span>
      <input bind:value={agencyName} placeholder="Cedar Valley ISD" required />
    </label>
    <div class="grid2">
      <label class="field">
        <span>Agency type</span>
        <select bind:value={agencyType}>
          {#each Object.entries(AGENCY_TYPE_LABELS) as [value, label] (value)}
            <option {value}>{label}</option>
          {/each}
        </select>
      </label>
      <label class="field">
        <span>Submission</span>
        <select bind:value={method}>
          {#each Object.entries(METHOD_LABELS) as [value, label] (value)}
            <option {value}>{label}</option>
          {/each}
        </select>
      </label>
    </div>
    <div class="grid2">
      <label class="field">
        <span>Due date &amp; time *</span>
        <input type="datetime-local" bind:value={dueAtLocal} required />
      </label>
      <label class="field">
        <span>Agency timezone</span>
        <select bind:value={timezone}>
          {#each tzs as tz (tz)}<option value={tz}>{tz}</option>{/each}
        </select>
      </label>
    </div>
    <div class="grid2">
      <label class="field">
        <span>Est. value ($)</span>
        <input bind:value={estValue} inputmode="numeric" placeholder="480000" />
      </label>
      <label class="field">
        <span>Bid #</span>
        <input bind:value={bidNumber} placeholder="RFP 26-114" />
      </label>
    </div>
    <div class="actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="submit" class="btn primary" disabled={!valid || saving}>Save bid</button>
    </div>
  </form>
</dialog>

<style>
  dialog { border: 0; border-radius: 16px; padding: 0; width: min(560px, calc(100vw - 32px)); box-shadow: 0 24px 60px rgba(22, 32, 44, 0.25); }
  dialog::backdrop { background: rgba(22, 32, 44, 0.35); }
  form { padding: 22px 24px; display: flex; flex-direction: column; gap: 14px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>
