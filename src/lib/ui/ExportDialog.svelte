<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { DATE_PRESET_LABELS, filterReportRows, summarizeByStage, withReportDefaults, type DatePreset, type ReportFilters } from '$lib/domain/report';
  import { OUTCOMES, ROUTE, STAGE_LABELS } from '$lib/domain/stages';
  import { AGENCY_TYPE_LABELS } from '$lib/domain/labels';
  import { CONTACT_ROLE_LABELS } from '$lib/domain/contacts';
  import { formatMoneyShort } from '$lib/domain/format';
  import type { AgencyType, ContactRole, Stage } from '$lib/domain/types';

  let { onClose }: { onClose: () => void } = $props();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let dialog: HTMLDialogElement | undefined = $state();
  let f = $state<ReportFilters>(untrack(() => structuredClone($state.snapshot(app.reportFilters))));
  let format = $state<'xlsx' | 'csv'>('xlsx');
  /** Contacts report (one row per bid contact) or Touches (one row per logged touch). */
  let what = $state<'contacts' | 'touches'>('contacts');
  let busy = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const rangeBad = $derived(!!f.from && !!f.to && f.from > f.to);
  const valueBad = $derived(f.minValue != null && f.maxValue != null && Number(f.minValue) > Number(f.maxValue));

  const preview = $derived(filterReportRows(app.reportRows, f, app.nowMs, zone));
  const summary = $derived(summarizeByStage(preview));
  const total = $derived(summary.reduce((s, x) => s + x.value, 0));
  const bidCount = $derived(summary.reduce((s, x) => s + x.bids, 0));
  const touchPreview = $derived(what === 'touches' ? app.touchReportRows(f, app.nowMs) : []);
  const count = $derived(what === 'touches' ? touchPreview.length : preview.length);

  const presets = Object.entries(DATE_PRESET_LABELS) as [DatePreset, string][];
  const stages: Stage[] = [...ROUTE, ...OUTCOMES];
  const agencyTypes = Object.keys(AGENCY_TYPE_LABELS) as AgencyType[];
  const roles = Object.keys(CONTACT_ROLE_LABELS) as ContactRole[];
  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  $effect(() => {
    dialog?.showModal();
    loading = true;
    void app.loadReportRows().then((err) => { error = err; loading = false; });
  });

  const nonNeg = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, n) : null;
  };

  async function run(e: SubmitEvent) {
    e.preventDefault();
    if (busy || loading) return;
    busy = true;
    error = null;
    const snap = $state.snapshot(f);
    const clean = withReportDefaults({ ...snap, from: f.from || null, to: f.to || null, minValue: nonNeg(f.minValue), maxValue: nonNeg(f.maxValue) });
    const r = what === 'touches' ? await app.exportTouchesReport(clean, format) : await app.exportContactsReport(clean, format);
    busy = false;
    if ('error' in r) error = r.error;
    else if (r.path) dialog?.close();
  }
</script>

<dialog bind:this={dialog} onclose={onClose} aria-labelledby="export-title">
  <form onsubmit={run}>
    <h2 id="export-title">Export report</h2>
    <fieldset class="fmt"><legend class="sr">Rows</legend>
      <label class="check"><input type="radio" bind:group={what} value="contacts" /> Contacts (one row per bid contact)</label>
      <label class="check"><input type="radio" bind:group={what} value="touches" /> Touches (one row per call, email, meeting or note)</label>
    </fieldset>

    <div class="grid2">
      <label class="field"><span>Date range</span>
        <select bind:value={f.preset}>{#each presets as [v, l] (v)}<option value={v}>{l}</option>{/each}</select>
      </label>
      <fieldset class="field" disabled={what === 'touches'}><legend>Based on</legend>
        <label class="check"><input type="radio" bind:group={f.dateField} value="due" /> Bid due date</label>
        <label class="check"><input type="radio" bind:group={f.dateField} value="created" /> Date bid was added</label>
      </fieldset>
    </div>
    {#if f.preset === 'custom'}
      <div class="grid2">
        <label class="field"><span>From</span><input type="date" bind:value={f.from} /></label>
        <label class="field"><span>To</span><input type="date" bind:value={f.to} /></label>
      </div>
    {/if}

    <fieldset><legend>Stages <small>(none checked = all)</small></legend>
      <div class="chips">{#each stages as s (s)}
        <label class="chip"><input type="checkbox" checked={f.stages.includes(s)} onchange={() => (f.stages = toggle(f.stages, s))} /> {STAGE_LABELS[s]}</label>
      {/each}</div>
      <p class="hint">Quotes use the same stages: Reviewing = Open, Submitted = Quoted, Awarded = Won, No bid = No reply. With “Due date”, a quote is dated by when it came in.</p>
    </fieldset>
    <fieldset><legend>Agency types</legend>
      <div class="chips">{#each agencyTypes as a (a)}
        <label class="chip"><input type="checkbox" checked={f.agencyTypes.includes(a)} onchange={() => (f.agencyTypes = toggle(f.agencyTypes, a))} /> {AGENCY_TYPE_LABELS[a]}</label>
      {/each}</div>
    </fieldset>
    {#if what === 'touches'}<p class="hint">Touches: the date range applies to when each touch happened; contact roles don’t apply.</p>{/if}
    <fieldset disabled={what === 'touches'}><legend>Contact roles</legend>
      <div class="chips">{#each roles as r (r)}
        <label class="chip"><input type="checkbox" checked={f.roles.includes(r)} onchange={() => (f.roles = toggle(f.roles, r))} /> {CONTACT_ROLE_LABELS[r]}</label>
      {/each}</div>
    </fieldset>
    <div class="grid2">
      <label class="field"><span>Min value ($)</span><input type="number" min="0" bind:value={f.minValue} /></label>
      <label class="field"><span>Max value ($)</span><input type="number" min="0" bind:value={f.maxValue} /></label>
    </div>
    <p class="hint">Bids use their est. value. Quotes use their quote total once they have priced lines.</p>

    {#if rangeBad}<p class="warn">From is after To</p>{/if}
    {#if valueBad}<p class="warn">Min is greater than max</p>{/if}

    <div class="preview" aria-live="polite">
      {#if loading}Loading…{:else if what === 'touches'}
        <strong>{touchPreview.length}</strong> touch{touchPreview.length === 1 ? '' : 'es'}
      {:else}
        <strong>{preview.length}</strong> contact row{preview.length === 1 ? '' : 's'} · {bidCount} bid{bidCount === 1 ? '' : 's'} · {formatMoneyShort(total)}
      {/if}
    </div>
    {#if error}<p class="err" role="alert">{error}</p>{/if}

    <div class="foot">
      <fieldset class="fmt"><legend class="sr">Format</legend>
        <label class="check"><input type="radio" bind:group={format} value="xlsx" /> Excel (.xlsx)</label>
        <label class="check"><input type="radio" bind:group={format} value="csv" /> CSV</label>
      </fieldset>
      <div class="actions">
        <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
        <button type="submit" class="btn primary" disabled={busy || loading || count === 0}>{busy ? 'Saving…' : 'Export'}</button>
      </div>
    </div>
  </form>
</dialog>

<style>
  dialog { border: 0; border-radius: 16px; padding: 0; width: min(680px, calc(100vw - 32px)); box-shadow: 0 24px 60px rgba(22, 32, 44, 0.25); }
  dialog::backdrop { background: rgba(22, 32, 44, 0.35); }
  form { padding: 22px 24px; display: flex; flex-direction: column; gap: 14px; max-height: calc(100vh - 64px); overflow: auto; }
  fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  legend { font-size: 12px; font-weight: 600; color: var(--muted); padding: 0; margin-bottom: 4px; }
  legend small { font-weight: 400; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 16px; font-size: 13px; }
  .warn { margin: 0; font-size: 12px; color: var(--red); }
  .err { margin: 0; padding: 10px 12px; border: 1px solid var(--red); border-radius: 10px; color: var(--red); font-size: 13px; }
  .preview { padding: 10px 12px; border-radius: 10px; background: var(--bg); }
  .foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .fmt { flex-direction: row; gap: 14px; }
  .actions { display: flex; gap: 8px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
