<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '$lib/state.svelte';
  import type { BidWithChildren, TouchKind } from '$lib/domain/types';
  import {
    chipAt, dayOf, defaultNextAt, dueAtOf, NEXT_CHIP_LABELS, nextPatch, partyOf, TOUCH_KIND_LABELS, TOUCH_KINDS, withOptions,
    type NextChip,
  } from '$lib/domain/touches';
  import { relDay } from '$lib/domain/rfq';
  import { isoToLocalInput, localToIso } from '$lib/domain/time';

  /**
   * Log a touch: kind · with · note · next step. `full` adds a "When" field (the Activity section); the quick
   * popover logs it as now. Enter saves (Cmd/Ctrl+Enter inside the note); Esc calls onClose.
   */
  let { data, full = false, onSaved, onClose }: {
    data: BidWithChildren; full?: boolean; onSaved?: () => void; onClose?: () => void;
  } = $props();

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const bid = $derived(data.bid);
  const nowLocal = () => isoToLocalInput(new Date().toISOString(), zone);
  const firstContact = (d: BidWithChildren) => withOptions(d, []).linked[0]?.value ?? '';

  let kind = $state<TouchKind>('call');
  let withValue = $state(untrack(() => firstContact(data)));
  let withTouched = false;
  let query = $state('');
  let note = $state('');
  let whenLocal = $state(nowLocal());
  let whenTouched = false;
  let chip = $state<NextChip>('none');
  let pickedDay = $state('');
  let nextText = $state('');
  let nextTouched = false;
  let busy = $state(false);

  const allContacts = $derived(app.contactList.map((c) => ({ id: c.contact.id, name: app.contactNames.get(c.contact.id) ?? '' })));
  const baseOptions = $derived(withOptions(data, allContacts, query));
  /** The selected contact stays in the list even when the search filters it out. */
  const options = $derived.by(() => {
    const o = baseOptions;
    const shown = [...o.linked, ...o.vendors, ...o.others].some((x) => x.value === withValue);
    if (!withValue || shown || !withValue.startsWith('c:')) return o;
    const id = withValue.slice(2);
    const sel = withOptions(data, allContacts, '', Number.MAX_SAFE_INTEGER).others.find((x) => x.value === withValue);
    return { ...o, others: [sel ?? { value: withValue, label: app.contactNames.get(id) ?? 'Selected contact' }, ...o.others] };
  });
  const nextChips = $derived<NextChip[]>([...(bid.nextAt ? (['keep'] as NextChip[]) : []), 'd2', 'w1', 'w2', 'pick', 'none']);
  const chipLabel = (c: NextChip) => (c === 'keep' ? `Keep (${relDay(Date.parse(bid.nextAt!), app.nowMs, zone)})` : NEXT_CHIP_LABELS[c]);

  /** Preselect the next step (spec §2) until the user picks one themselves. */
  function preselect() {
    if (nextTouched) return;
    const d = defaultNextAt(bid, dueAtOf(data), kind, Date.now(), app.notificationSettings);
    chip = d.chip;
    pickedDay = d.chip === 'pick' ? dayOf(d.at, bid.timezone) : '';
    nextText = d.chip === 'keep' ? bid.nextText ?? '' : '';
  }
  /** The chosen chip, falling back when "Keep" no longer applies (the step was cleared elsewhere). */
  function effectiveChip(): NextChip {
    if (chip === 'keep' && !bid.nextAt) {
      preselect();
      return chip === 'keep' ? 'none' : chip;
    }
    return chip;
  }
  $effect(() => {
    void kind;
    void bid.nextAt;
    void bid.nextText;
    untrack(preselect);
  });

  function setKind(k: TouchKind) {
    kind = k;
    if (!withTouched) withValue = k === 'note' ? '' : firstContact(data);
  }
  function setChip(c: NextChip) {
    nextTouched = true;
    chip = c;
    if (c === 'pick' && !pickedDay) pickedDay = dayOf(chipAt('w1', Date.now(), bid.timezone), bid.timezone);
    if (c === 'keep') nextText = bid.nextText ?? '';
  }

  async function save() {
    if (busy) return;
    let at: string | null = null;
    let next: ReturnType<typeof nextPatch>;
    try {
      if (full) {
        if (!whenTouched) whenLocal = nowLocal();
        at = localToIso(whenLocal, zone);
      }
      const c = effectiveChip();
      next = nextPatch(bid, c, pickedDay, nextText, Date.now());
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
      return;
    }
    busy = true;
    const ok = await app.logTouch({ bidId: bid.id, kind, ...partyOf(withValue), note, at }, next);
    busy = false;
    if (!ok) return;
    note = '';
    whenLocal = nowLocal();
    whenTouched = false;
    nextTouched = false;
    withTouched = false;
    preselect();
    onSaved?.();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && onClose) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    const t = e.target as HTMLElement;
    if (t.tagName === 'BUTTON') return;
    if (t.classList.contains('find')) {
      e.preventDefault();
      const hit = baseOptions.others[0];
      if (hit && query.trim()) { withValue = hit.value; withTouched = true; }
      return;
    }
    if (t.tagName === 'TEXTAREA' && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    void save();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form class="composer" class:full onsubmit={(e) => { e.preventDefault(); void save(); }} onkeydown={onKey}>
  <div class="chips" role="group" aria-label="Type">
    {#each TOUCH_KINDS as k (k)}
      <button type="button" class="chip" class:on={kind === k} aria-pressed={kind === k} onclick={() => setKind(k)}>{TOUCH_KIND_LABELS[k]}</button>
    {/each}
  </div>
  <div class="with">
    <label class="sr" for="with-{bid.id}-{full}">With</label>
    <select id="with-{bid.id}-{full}" bind:value={withValue} onchange={() => (withTouched = true)}>
      {#if options.linked.length}
        <optgroup label="On this {bid.kind === 'rfq' ? 'quote' : 'bid'}">
          {#each options.linked as o (o.value)}<option value={o.value}>With: {o.label}</option>{/each}
        </optgroup>
      {/if}
      {#if options.vendors.length}
        <optgroup label="Vendors">
          {#each options.vendors as o (o.value)}<option value={o.value}>With: {o.label}</option>{/each}
        </optgroup>
      {/if}
      {#if options.others.length}
        <optgroup label="All contacts">
          {#each options.others as o (o.value)}<option value={o.value}>With: {o.label}</option>{/each}
        </optgroup>
      {/if}
      <option value="">With: nobody</option>
    </select>
    <input class="find" type="search" placeholder="Find contact" aria-label="Find a contact" bind:value={query} />
  </div>
  <textarea rows="2" placeholder="What happened… (⌘/Ctrl+Enter saves)" aria-label="Note" bind:value={note}></textarea>
  {#if full}
    <label class="when"><span>When</span><input type="datetime-local" bind:value={whenLocal} oninput={() => (whenTouched = true)} required /></label>
  {/if}
  <div class="lbl">Next</div>
  <div class="chips" role="group" aria-label="Next step">
    {#each nextChips as c (c)}
      <button type="button" class="chip" class:on={chip === c} aria-pressed={chip === c} onclick={() => setChip(c)}>{chipLabel(c)}</button>
    {/each}
  </div>
  {#if chip === 'pick'}
    <input type="date" aria-label="Next step date" bind:value={pickedDay} oninput={() => (nextTouched = true)} />
  {/if}
  {#if chip !== 'none'}
    <input type="text" placeholder="Next step (optional), e.g. send revised quote" aria-label="Next step" bind:value={nextText}
      oninput={() => (nextTouched = true)} />
  {/if}
  <div class="foot">
    {#if onClose}<button type="button" class="mini" onclick={onClose}>Cancel</button>{/if}
    <button type="submit" class="mini primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
  </div>
</form>

<style>
  .composer { display: flex; flex-direction: column; gap: 9px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--line); background: var(--card); font-size: 12px; font-weight: 600; color: var(--ink-2); }
  .chip.on { background: var(--ink); border-color: var(--ink); color: #fff; }
  .with { display: flex; gap: 6px; }
  .with select { flex: 1; min-width: 0; }
  .find { width: 120px; }
  select, input, textarea { height: 32px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px; background: #fff; font-size: 13px; }
  textarea { height: auto; min-height: 48px; padding: 6px 8px; resize: vertical; }
  .when { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--muted); }
  .lbl { font-size: 11px; font-weight: 700; color: var(--muted); letter-spacing: 0.06em; text-transform: uppercase; }
  .foot { display: flex; justify-content: flex-end; gap: 6px; }
  .mini { height: 28px; padding: 0 12px; border-radius: 14px; border: 1px solid var(--line); background: var(--card); font-size: 12px; font-weight: 600; color: var(--ink-2); }
  .mini.primary { background: var(--ink); color: #fff; border-color: var(--ink); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
