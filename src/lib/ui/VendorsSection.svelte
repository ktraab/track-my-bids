<script lang="ts">
  import { app } from '$lib/state.svelte';
  import type { BidWithChildren, Contact } from '$lib/domain/types';
  import { contactName, matchesContact } from '$lib/domain/contacts';
  import { formatStopDate, localToIso } from '$lib/domain/time';
  import { isPending, liveVendors, vendorNudgeAt, vendorStatusText } from '$lib/domain/rfq';

  /** `collapsible`: bid detail shows only an "Add vendors" button until the first vendor exists. */
  let { data, collapsible = false }: { data: BidWithChildren; collapsible?: boolean } = $props();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const vendors = $derived(liveVendors(data.vendorQuotes));
  const replied = $derived(vendors.filter((v) => v.repliedAt).length);
  let opened = $state(false);
  const expanded = $derived(!collapsible || opened || vendors.length > 0);

  let name = $state('');
  let contactId = $state<string | null>(null);
  let askedLocal = $state(''); // '' = now
  let notesFor = $state<string | null>(null);
  let notesText = $state('');
  let confirmRemove = $state<string | null>(null);
  const matches = $derived(
    !contactId && name.trim().length >= 2
      ? app.contactList.filter((c) => matchesContact(c.contact, name)).slice(0, 6)
      : [],
  );

  /** A vendor reads as its company; fall back to the person's name. */
  const vendorLabel = (c: Contact) => c.organization?.trim() || contactName(c);

  function pick(c: Contact) {
    contactId = c.id;
    name = vendorLabel(c);
  }

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    let askedAt: string | null = null;
    if (askedLocal) {
      try {
        askedAt = localToIso(askedLocal, zone);
      } catch {
        app.error = 'The asked time looks wrong.';
        return;
      }
    }
    if (await app.addVendor(data.bid.id, { vendorName: name, contactId, askedAt })) {
      name = '';
      contactId = null;
      askedLocal = '';
    }
  }

  function editNotes(id: string, current: string | null) {
    notesFor = id;
    notesText = current ?? '';
  }

  async function saveNotes(e: SubmitEvent, id: string) {
    e.preventDefault();
    if (await app.updateVendor(id, { notes: notesText })) notesFor = null;
  }

  async function remove(id: string) {
    if (await app.removeVendor(id)) confirmRemove = null;
  }
</script>

{#if !expanded}
  <section class="card box">
    <div class="head"><h2>Vendors</h2></div>
    <p class="hint">Track which vendors you asked for pricing and who has replied.</p>
    <div><button class="btn" onclick={() => (opened = true)}>Add vendors</button></div>
  </section>
{:else}
  <section class="card box">
    <div class="head">
      <h2>Vendors</h2>
      {#if vendors.length}<span class="hint">{replied}/{vendors.length} replied</span>{/if}
    </div>
    {#if vendors.length}
      <ul>
        {#each vendors as v (v.id)}
          {@const quiet = isPending(v) && vendorNudgeAt(v, zone, app.followUp) <= app.nowMs}
          <li>
            <div class="row">
              <div class="who">
                <strong>{v.vendorName}</strong>
                <span class="hint">Asked {formatStopDate(v.askedAt, zone)}{v.nudgedAt ? ` · nudged ${formatStopDate(v.nudgedAt, zone)}` : ''}</span>
              </div>
              <span class="state" class:late-text={quiet} class:ok={!!v.repliedAt}>{vendorStatusText(v, app.nowMs, zone, app.followUp)}</span>
              <div class="acts">
                {#if v.repliedAt}
                  <button class="btn sm" onclick={() => app.setVendorReplied(v.id, false)}>Undo reply</button>
                {:else if v.skipped}
                  <button class="btn sm" onclick={() => app.setVendorSkipped(v.id, false)}>Undo skip</button>
                {:else}
                  <button class="btn sm primary" onclick={() => app.setVendorReplied(v.id, true)}>Mark replied</button>
                  <button class="btn sm" title="Copy a follow-up message and record the nudge" onclick={() => app.nudgeVendor(data.bid.id, v.id)}>Nudge</button>
                  <button class="btn sm" title="Quote without this vendor" onclick={() => app.setVendorSkipped(v.id, true)}>Skip</button>
                {/if}
                <button class="btn sm" onclick={() => editNotes(v.id, v.notes)}>Notes</button>
                {#if confirmRemove === v.id}
                  <button class="btn sm danger" onclick={() => remove(v.id)}>Confirm remove</button>
                  <button class="btn sm" onclick={() => (confirmRemove = null)}>Keep</button>
                {:else}
                  <button class="icon" aria-label="Remove {v.vendorName}" onclick={() => (confirmRemove = v.id)}>✕</button>
                {/if}
              </div>
            </div>
            {#if notesFor === v.id}
              <form class="notes" onsubmit={(e) => saveNotes(e, v.id)}>
                <textarea bind:value={notesText} rows="2" aria-label="Notes for {v.vendorName}"></textarea>
                <div class="acts">
                  <button class="btn sm" type="button" onclick={() => (notesFor = null)}>Cancel</button>
                  <button class="btn sm primary" type="submit">Save notes</button>
                </div>
              </form>
            {:else if v.notes}
              <p class="note">{v.notes}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    <form class="add" onsubmit={add}>
      <input class="vname" bind:value={name} oninput={() => (contactId = null)} placeholder="Vendor (type a name or search contacts)" aria-label="Vendor" />
      <label class="asked"><span class="hint">Asked</span>
        <input type="datetime-local" bind:value={askedLocal} aria-label="Asked at (leave blank for now)" />
      </label>
      <button class="btn" type="submit" disabled={!name.trim()}>Add vendor</button>
    </form>
    {#if matches.length}
      <div class="sugg">
        {#each matches as c (c.contact.id)}
          <button type="button" onclick={() => pick(c.contact)}>{vendorLabel(c.contact)}{c.contact.organization ? ` · ${contactName(c.contact)}` : ''}</button>
        {/each}
      </div>
    {/if}
    <p class="hint">Leave “Asked” blank for now. Nudge copies a short follow-up you can paste into an email.</p>
  </section>
{/if}

<style>
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  li { padding: 8px 0; border-top: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .who { flex: 1 1 180px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .state { font-size: 13px; color: var(--ink-2); }
  .state.ok { color: var(--cust-ink); font-weight: 600; }
  .acts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .btn.sm { height: 30px; padding: 0 10px; font-size: 12px; }
  .note { margin: 0; font-size: 13px; color: var(--ink-2); white-space: pre-wrap; }
  .notes { display: flex; flex-direction: column; gap: 6px; }
  .notes textarea { border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; resize: vertical; }
  .vname { flex: 1 1 220px; }
  .asked { display: flex; align-items: center; gap: 6px; }
  .sugg { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-top: -4px; }
  .sugg button { text-align: left; padding: 8px 10px; border: 0; background: #fff; }
  .sugg button + button { border-top: 1px solid var(--line-soft); }
  .sugg button:hover, .sugg button:focus-visible { background: var(--line-soft); }
</style>
