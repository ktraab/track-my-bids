<script lang="ts">
  import { DateTime } from 'luxon';
  import { app } from '$lib/state.svelte';
  import type { BidWithChildren, Touch } from '$lib/domain/types';
  import {
    canDeleteTouch, chipAt, dayOf, NEXT_CHIP_LABELS, nextPatch, PARTY_COLORS, touchParty, touchTitle, type NextChip,
  } from '$lib/domain/touches';
  import { initials } from '$lib/domain/ownership';
  import { isoToLocalInput, localToIso } from '$lib/domain/time';
  import TouchComposer from './TouchComposer.svelte';

  /** Detail-page Activity (spec §3): next-step banner, full composer, timeline newest first. */
  let { data }: { data: BidWithChildren } = $props();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const SHOW = 20;
  const bid = $derived(data.bid);
  const teamOn = $derived(app.team.mode === 'team');
  let showAll = $state(false);
  const list = $derived(showAll ? data.touches : data.touches.slice(0, SHOW));

  // Next-step editor ("Change" / "+ Add next step").
  let editingNext = $state(false);
  let chip = $state<NextChip>('w1');
  let pickedDay = $state('');
  let nextText = $state('');
  let origDay = '';
  const todayDay = $derived(dayOf(new Date(app.nowMs).toISOString(), bid.timezone));
  const EDIT_CHIPS = ['d2', 'w1', 'w2', 'pick'] as const;
  function startNext() {
    chip = bid.nextAt ? 'pick' : 'w1';
    pickedDay = dayOf(bid.nextAt, bid.timezone);
    origDay = pickedDay;
    nextText = bid.nextText ?? '';
    editingNext = true;
  }
  function setChip(c: NextChip) {
    chip = c;
    if (c === 'pick' && !pickedDay) pickedDay = dayOf(chipAt('w1', Date.now(), bid.timezone), bid.timezone);
  }
  async function saveNext(e: SubmitEvent) {
    e.preventDefault();
    let p: ReturnType<typeof nextPatch>;
    try { p = nextPatch(bid, chip, pickedDay, nextText, Date.now()); } catch (err) { app.error = err instanceof Error ? err.message : String(err); return; }
    if (p && chip === 'pick' && bid.nextAt && pickedDay === origDay) p = { nextAt: bid.nextAt, nextText: p.nextText }; // same day: keep its time
    if (!p || (await app.setNextStep(bid.id, p.nextAt, p.nextText))) editingNext = false;
  }
  const nextWhen = (iso: string) => DateTime.fromISO(iso).setZone(zone).toFormat('ccc LLL d');
  const nextLate = $derived(!!bid.nextAt && Date.parse(bid.nextAt) <= app.nowMs);

  // Timeline row edit / delete.
  let editId = $state<string | null>(null);
  let editNote = $state('');
  let editWhen = $state('');
  let confirmId = $state<string | null>(null);
  function startEdit(t: Touch) {
    editId = t.id;
    editNote = t.note ?? '';
    editWhen = isoToLocalInput(t.at, zone);
    confirmId = null;
  }
  async function saveEdit(e: SubmitEvent, t: Touch) {
    e.preventDefault();
    let at: string;
    try { at = localToIso(editWhen, zone); } catch { app.error = 'The time looks wrong.'; return; }
    if (await app.updateTouch(t.id, { note: editNote, at })) editId = null;
  }
  const when = (iso: string) => DateTime.fromISO(iso).setZone(zone).toFormat('ccc LLL d, h:mm a');
  const SOURCE_TAG: Record<Touch['source'], string> = { manual: '', nudge: 'Nudge', followup: 'Follow-up' };
</script>

<section class="card box activity" aria-label="Activity">
  <h2>Activity</h2>

  {#if editingNext}
    <form class="next-edit" onsubmit={saveNext}>
      <div class="chips" role="group" aria-label="Next step date">
        {#each EDIT_CHIPS as c (c)}
          <button type="button" class="chip" class:on={chip === c} aria-pressed={chip === c} onclick={() => setChip(c)}>{NEXT_CHIP_LABELS[c]}</button>
        {/each}
      </div>
      {#if chip === 'pick'}<input type="date" aria-label="Next step date" min={todayDay} bind:value={pickedDay} required />{/if}
      <input type="text" placeholder="Next step, e.g. send revised quote" aria-label="Next step" bind:value={nextText} />
      <div class="row">
        <button type="button" class="mini" onclick={() => (editingNext = false)}>Cancel</button>
        <button type="submit" class="mini primary">Save next step</button>
      </div>
    </form>
  {:else if bid.nextAt}
    <div class="next" class:late={nextLate}>
      <span><strong>Next · {nextWhen(bid.nextAt)}</strong>{#if bid.nextText} — {bid.nextText}{/if}</span>
      <span class="sp"></span>
      <button class="linkish" onclick={() => app.clearNextStep(bid.id)}>Done</button>
      <button class="linkish" onclick={startNext}>Change</button>
    </div>
  {:else}
    <button class="linkish add-next" onclick={startNext}>+ Add next step</button>
  {/if}

  <TouchComposer {data} full />

  <ol class="timeline">
    {#each list as t (t.id)}
      {@const party = touchParty(t)}
      <li>
        <span class="dot" style:background={PARTY_COLORS[party]} aria-hidden="true"></span>
        <div class="body">
          <div class="title">
            <strong>{touchTitle(t, data, app.contactNames)}</strong>
            {#if SOURCE_TAG[t.source]}<span class="auto">{SOURCE_TAG[t.source]}</span>{/if}
            {#if teamOn && t.authorId}<span class="auto" title={app.memberName(t.authorId)}>{initials(app.memberName(t.authorId))}</span>{/if}
            <time datetime={t.at}>{when(t.at)}</time>
            <span class="sp"></span>
            {#if editId !== t.id}
              <button class="linkish" onclick={() => startEdit(t)}>Edit</button>
              {#if canDeleteTouch(t, bid, app.meId, app.myRole)}
                {#if confirmId === t.id}
                  <button class="linkish danger" onclick={() => app.deleteTouch(t.id)}>Confirm delete</button>
                  <button class="linkish" onclick={() => (confirmId = null)}>Keep</button>
                {:else}
                  <button class="linkish" onclick={() => (confirmId = t.id)}>Delete</button>
                {/if}
              {/if}
            {/if}
          </div>
          {#if editId === t.id}
            <form class="edit" onsubmit={(e) => saveEdit(e, t)}>
              <textarea rows="2" aria-label="Note" bind:value={editNote}></textarea>
              <input type="datetime-local" aria-label="When" bind:value={editWhen} required />
              <div class="row">
                <button type="button" class="mini" onclick={() => (editId = null)}>Cancel</button>
                <button type="submit" class="mini primary">Save</button>
              </div>
            </form>
          {:else if t.note}
            <p class="note">{t.note}</p>
          {/if}
        </div>
      </li>
    {:else}
      <li class="empty">No touches yet. Log calls, emails, meetings and notes above.</li>
    {/each}
  </ol>
  {#if !showAll && data.touches.length > SHOW}
    <button class="linkish" onclick={() => (showAll = true)}>Show all {data.touches.length}</button>
  {/if}
</section>

<style>
  .next { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 8px; background: var(--cust-soft); font-size: 13px; }
  .next.late { background: var(--red-soft); color: var(--red); }
  .sp { flex: 1; }
  .add-next { align-self: flex-start; font-size: 13px; }
  .next-edit, .edit { display: flex; flex-direction: column; gap: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--line); background: var(--card); font-size: 12px; font-weight: 600; color: var(--ink-2); }
  .chip.on { background: var(--ink); border-color: var(--ink); color: #fff; }
  .row { display: flex; justify-content: flex-end; gap: 6px; }
  .mini { height: 28px; padding: 0 12px; border-radius: 14px; border: 1px solid var(--line); background: var(--card); font-size: 12px; font-weight: 600; color: var(--ink-2); }
  .mini.primary { background: var(--ink); color: #fff; border-color: var(--ink); }
  input, textarea { height: 32px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px; background: #fff; font-size: 13px; }
  textarea { height: auto; min-height: 48px; padding: 6px 8px; resize: vertical; }
  .timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .timeline li { display: flex; gap: 10px; align-items: flex-start; }
  .dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 4px; flex: none; }
  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 13px; }
  .title time { color: var(--muted); font-size: 12px; }
  .auto { font-size: 10px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
  .note { margin: 0; font-size: 13px; color: var(--ink-2); white-space: pre-wrap; }
  .linkish { font-size: 12px; }
  .linkish.danger { color: var(--red); }
  .empty { color: var(--muted); font-size: 13px; }
</style>
