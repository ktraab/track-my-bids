<script lang="ts">
  import { DateTime } from 'luxon';
  import { app } from '$lib/state.svelte';
  import { AGENCY_TYPE_LABELS, METHOD_LABELS, timezoneOptions } from '$lib/domain/labels';
  import { contactName, matchesContact, type ContactInput } from '$lib/domain/contacts';
  import { LOCAL_INPUT_FORMAT, localToIso } from '$lib/domain/time';
  import type { AgencyType, BidKind, Method } from '$lib/domain/types';

  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzs = timezoneOptions(systemTz);

  let dialog: HTMLDialogElement | undefined = $state();
  let kind = $state<BidKind>('bid');
  let title = $state('');
  let agencyName = $state('');
  let agencyType = $state<AgencyType>('k12');
  let method = $state<Method>('online');
  let dueAtLocal = $state('');
  let timezone = $state(systemTz);
  let estValue = $state('');
  let bidNumber = $state('');
  let receivedLocal = $state(DateTime.now().setZone(systemTz).toFormat(LOCAL_INPUT_FORMAT));
  let ownerId = $state(app.meId ?? ''); // '' = unassigned (Team mode)
  let contactQuery = $state('');
  let contactEmail = $state('');
  let pickedContactId = $state<string | null>(null);
  let saving = $state(false);

  const teamOn = $derived(app.team.mode === 'team');
  const owners = $derived(app.team.members.filter((m) => m.active && m.role !== 'pending'));
  const contactMatches = $derived(
    !pickedContactId && contactQuery.trim().length >= 2
      ? app.contactList.filter((c) => matchesContact(c.contact, contactQuery)).slice(0, 6)
      : [],
  );
  const valid = $derived(!!title.trim() && !!agencyName.trim() && (kind === 'bid' ? !!dueAtLocal : !!receivedLocal));

  $effect(() => {
    dialog?.showModal();
  });

  function parseMoney(s: string): number | null {
    const n = Number(s.replace(/[^0-9.]/g, ''));
    return s.trim() && Number.isFinite(n) ? Math.round(n) : null;
  }

  /** Picked contact, or a new one from the typed name/email (organization = the customer), or none. */
  function quoteContact(): { existingId: string } | { input: ContactInput } | null {
    if (pickedContactId) return { existingId: pickedContactId };
    const name = contactQuery.trim();
    const email = contactEmail.trim();
    if (!name && !email) return null;
    const [first, ...rest] = name.split(/\s+/).filter(Boolean);
    return { input: { firstName: first ?? null, lastName: rest.join(' ') || null, email: email || null, organization: agencyName.trim() } };
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    saving = true;
    let id: string | null;
    if (kind === 'bid') {
      id = await app.createBid({
        title: title.trim(),
        agencyName: agencyName.trim(),
        agencyType,
        submissionMethod: method,
        dueAtLocal,
        timezone,
        estValue: parseMoney(estValue),
        bidNumber: bidNumber.trim() || null,
      });
    } else {
      let receivedAt: string;
      try {
        receivedAt = localToIso(receivedLocal, systemTz);
      } catch {
        app.error = 'The received time looks wrong.';
        saving = false;
        return;
      }
      id = await app.createQuote(
        {
          title: title.trim(),
          agencyName: agencyName.trim(),
          agencyType,
          timezone: systemTz,
          receivedAt,
          ...(teamOn ? { ownerId: ownerId || null } : {}),
        },
        quoteContact(),
      );
    }
    saving = false;
    if (id) dialog?.close();
  }

  function pickContact(id: string, name: string) {
    pickedContactId = id;
    contactQuery = name;
  }
</script>

<dialog bind:this={dialog} onclose={() => (app.quickAddOpen = false)} aria-labelledby="qa-title">
  <form onsubmit={save}>
    <div class="head">
      <h2 id="qa-title">{kind === 'bid' ? 'New bid' : 'New quote'}</h2>
      <div class="kind" role="group" aria-label="What are you adding?">
        <button type="button" class:on={kind === 'bid'} aria-pressed={kind === 'bid'} onclick={() => (kind = 'bid')}>Bid</button>
        <button type="button" class:on={kind === 'rfq'} aria-pressed={kind === 'rfq'} onclick={() => (kind = 'rfq')}>Quote</button>
      </div>
    </div>
    <p class="hint">
      {kind === 'bid' ? 'A formal solicitation with a due date.' : 'A quick price request: no due date, tracked by who has the ball.'}
    </p>

    {#if kind === 'bid'}
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
            {#each Object.entries(AGENCY_TYPE_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span>Submission</span>
          <select bind:value={method}>
            {#each Object.entries(METHOD_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
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
    {:else}
      <label class="field">
        <span>Customer *</span>
        <input bind:value={agencyName} placeholder="Henrico County Public Schools" required />
      </label>
      <label class="field">
        <span>What they want *</span>
        <input bind:value={title} placeholder="Chromebook carts × 40" required />
      </label>
      <div class="grid2">
        <label class="field">
          <span>Agency type</span>
          <select bind:value={agencyType}>
            {#each Object.entries(AGENCY_TYPE_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span>Received</span>
          <input type="datetime-local" bind:value={receivedLocal} required />
        </label>
      </div>
      <div class="grid2">
        <label class="field">
          <span>Contact (optional)</span>
          <input bind:value={contactQuery} oninput={() => (pickedContactId = null)} placeholder="Name, or search contacts" />
        </label>
        {#if pickedContactId}
          <div class="field">
            <span>&nbsp;</span>
            <p class="hint picked">Existing contact · <button type="button" class="linkish" onclick={() => { pickedContactId = null; contactQuery = ''; }}>change</button></p>
          </div>
        {:else}
          <label class="field">
            <span>Contact email</span>
            <input type="email" bind:value={contactEmail} placeholder="buyer@agency.gov" />
          </label>
        {/if}
      </div>
      {#if contactMatches.length}
        <div class="sugg">
          {#each contactMatches as c (c.contact.id)}
            <button type="button" onclick={() => pickContact(c.contact.id, contactName(c.contact))}>
              {contactName(c.contact)}{c.contact.organization ? ` · ${c.contact.organization}` : ''}
            </button>
          {/each}
        </div>
      {/if}
      {#if teamOn}
        <label class="field">
          <span>Owner</span>
          <select bind:value={ownerId}>
            <option value="">Unassigned</option>
            {#each owners as m (m.id)}<option value={m.id}>{m.displayName || m.email}{m.id === app.meId ? ' (me)' : ''}</option>{/each}
          </select>
        </label>
      {/if}
    {/if}

    <div class="actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="submit" class="btn primary" disabled={!valid || saving}>{kind === 'bid' ? 'Save bid' : 'Save quote'}</button>
    </div>
  </form>
</dialog>

<style>
  dialog { border: 0; border-radius: 16px; padding: 0; width: min(560px, calc(100vw - 32px)); box-shadow: 0 24px 60px rgba(22, 32, 44, 0.25); }
  dialog::backdrop { background: rgba(22, 32, 44, 0.35); }
  form { padding: 22px 24px; display: flex; flex-direction: column; gap: 14px; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .kind { display: inline-flex; border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
  .kind button { height: 32px; padding: 0 16px; border: 0; background: #fff; font-weight: 600; color: var(--ink-2); }
  .kind button + button { border-left: 1px solid var(--line); }
  .kind button.on { background: var(--ink); color: #fff; }
  .sugg { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-top: -6px; }
  .sugg button { text-align: left; padding: 8px 10px; border: 0; background: #fff; }
  .sugg button + button { border-top: 1px solid var(--line-soft); }
  .sugg button:hover, .sugg button:focus-visible { background: var(--line-soft); }
  .picked { padding-top: 10px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>
