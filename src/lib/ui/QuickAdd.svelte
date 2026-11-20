<script lang="ts">
  import { DateTime } from 'luxon';
  import { app } from '$lib/state.svelte';
  import { AGENCY_TYPE_LABELS, METHOD_LABELS, MILESTONE_TYPE_LABELS, SHIP_METHOD_LABELS, timezoneOptions } from '$lib/domain/labels';
  import { contactName, matchesContact, type ContactInput } from '$lib/domain/contacts';
  import { LOCAL_INPUT_FORMAT, localToIso } from '$lib/domain/time';
  import { agencyMemory } from '$lib/domain/agencyMemory';
  import { candidateFormValue, fillForm, learningEvents, suggestedStops, type DocForm, type FieldSource, type FormKey, type SuggestedStop } from '$lib/domain/docFill';
  import { parseFundingYear, toErateCategory } from '$lib/domain/erate';
  import type { BidPatch } from '$lib/db/bids';
  import type { BidKind } from '$lib/domain/types';
  import type { Candidate, ContactGuess } from '$lib/domain/extract';
  import SuggestDot from './SuggestDot.svelte';

  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzs = timezoneOptions(systemTz);

  /** The form's starting values: an input still equal to these counts as blank (documents may fill it). */
  const BLANK: DocForm = {
    title: '', agencyName: '', agencyType: 'k12', method: 'online', dueAtLocal: '', timezone: systemTz, estValue: '',
    bidNumber: '', scope: '', portalName: '', portalUrl: '', deliveryAddress: '', copiesRequired: '', notarizeRequired: false,
    shipMethod: '', shipLeadBusinessDays: 2, erate: false, erate470Number: '', erateFundingYear: '', erateCategory: '',
  };

  let dialog: HTMLDialogElement | undefined = $state();
  let kind = $state<BidKind>('bid');
  let f = $state<DocForm>({ ...BLANK });
  let receivedLocal = $state(DateTime.now().setZone(systemTz).toFormat(LOCAL_INPUT_FORMAT));
  let ownerId = $state(app.meId ?? ''); // '' = unassigned (Team mode)
  let contactQuery = $state('');
  let contactEmail = $state('');
  let pickedContactId = $state<string | null>(null);
  let saving = $state(false);

  // Document import (bids only): where each pre-filled value came from, offered milestones and contact.
  let sources = $state<Partial<Record<FormKey, FieldSource>>>({});
  let stops = $state<SuggestedStop[]>([]);
  let addContact = $state(true);
  /** The buyer a document named (kept when a later document names none). Contacts need an email. */
  let docContact = $state<ContactGuess | null>(null);
  let filledSeq = 0;
  let seenSeq = 0;

  const doc = $derived(app.docImport);
  const showDetails = $derived(kind === 'bid' && !!doc && doc.status !== 'reading');
  const teamOn = $derived(app.team.mode === 'team');
  const owners = $derived(app.team.members.filter((m) => m.active && m.role !== 'pending'));
  const contactMatches = $derived(
    !pickedContactId && contactQuery.trim().length >= 2
      ? app.contactList.filter((c) => matchesContact(c.contact, contactQuery)).slice(0, 6)
      : [],
  );
  const valid = $derived(!!f.title.trim() && !!f.agencyName.trim() && (kind === 'bid' ? !!f.dueAtLocal : !!receivedLocal));
  const docNote = $derived(
    !doc ? '' : doc.status === 'reading' ? `Reading ${doc.name}…`
      : doc.status === 'no_text' ? 'No readable text — this looks like a scan.'
      : doc.status === 'error' ? (doc.error ?? 'Couldn’t read this file.')
      : doc.status === 'empty' ? 'Couldn’t find bid details in this document.'
      : `Filled from ${doc.name}. Check every field before saving.`,
  );

  $effect(() => {
    dialog?.showModal();
  });

  // A new document (dropped even while Quote is showing) switches to the bid form, so Reading… / errors show.
  $effect(() => {
    const d = app.docImport;
    if (!d || d.seq === seenSeq) return;
    seenSeq = d.seq;
    kind = 'bid';
  });

  // A finished document fills the inputs that are still blank (also when it arrives while the form is open).
  $effect(() => {
    const d = app.docImport;
    if (!d || d.status !== 'ready' || !d.suggestions || d.seq === filledSeq) return;
    filledSeq = d.seq;
    kind = 'bid';
    const sug = $state.snapshot(d.suggestions) as typeof d.suggestions;
    const contactEmailGuess = sug.contact?.email ?? null;
    const agency = f.agencyName.trim() || sug.fields.agency_name?.[0]?.value || null;
    const memory = agencyMemory(app.bidsSnapshot(), agency, contactEmailGuess);
    const res = fillForm($state.snapshot(f) as DocForm, BLANK, sug, memory);
    f = res.form;
    sources = { ...sources, ...res.sources };
    const have = new Set(stops.map((s) => s.type));
    stops = [...stops, ...suggestedStops(sug).filter((s) => !have.has(s.type))];
    if (sug.contact?.email?.trim()) docContact = sug.contact;
  });

  function close() {
    app.quickAddOpen = false;
    app.docImport = null;
  }

  function parseMoney(s: string): number | null {
    const n = Number(s.replace(/[^0-9.]/g, ''));
    return s.trim() && Number.isFinite(n) ? Math.round(n) : null;
  }
  const txt = (s: string) => s.trim() || null;

  /** Picking another candidate for an input (validated like the first fill; a value the input can't hold is ignored). */
  function pick(key: FormKey, c: Candidate) {
    const v = candidateFormValue(key, c);
    if (v !== null) (f as unknown as Record<FormKey, unknown>)[key] = v;
  }

  /** SuggestDot props for an input: its source, current value and how to pick another candidate. */
  function dot(key: FormKey) {
    return {
      source: sources[key],
      value: f[key],
      formValue: (c: Candidate) => candidateFormValue(key, c),
      onpick: (c: Candidate) => pick(key, c),
    };
  }

  /** Picked contact, or a new one from the typed name/email (organization = the customer), or none. */
  function quoteContact(): { existingId: string } | { input: ContactInput } | null {
    if (pickedContactId) return { existingId: pickedContactId };
    const name = contactQuery.trim();
    const email = contactEmail.trim();
    if (!name && !email) return null;
    const [first, ...rest] = name.split(/\s+/).filter(Boolean);
    return { input: { firstName: first ?? null, lastName: rest.join(' ') || null, email: email || null, organization: f.agencyName.trim() } };
  }

  /**
   * Details only the document form shows (one update after the bid is created). Only inputs the current
   * submission method shows, and only values that differ from a new bid's defaults (empty = no update).
   */
  function details(): BidPatch {
    const p: Record<string, unknown> = {};
    const set = (k: keyof BidPatch, v: unknown) => { if (v !== null && v !== false) p[k] = v; };
    set('scope', txt(f.scope));
    if (f.method === 'online') {
      set('portalName', txt(f.portalName));
      set('portalUrl', txt(f.portalUrl));
    } else if (f.method === 'sealed') {
      set('deliveryAddress', txt(f.deliveryAddress));
      set('copiesRequired', parseMoney(f.copiesRequired));
      set('notarizeRequired', f.notarizeRequired);
      set('shipMethod', f.shipMethod || null);
      const lead = Math.max(0, Math.round(Number(f.shipLeadBusinessDays) || 0));
      if (lead !== BLANK.shipLeadBusinessDays) p.shipLeadBusinessDays = lead;
    }
    if (f.erate) {
      p.erate = true;
      set('erate470Number', txt(f.erate470Number));
      set('erateFundingYear', parseFundingYear(f.erateFundingYear));
      set('erateCategory', toErateCategory(f.erateCategory));
    }
    return p as BidPatch;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    saving = true;
    let id: string | null;
    if (kind === 'bid') {
      const input = {
        title: f.title.trim(),
        agencyName: f.agencyName.trim(),
        agencyType: f.agencyType,
        submissionMethod: f.method,
        dueAtLocal: f.dueAtLocal,
        timezone: f.timezone,
        estValue: parseMoney(f.estValue),
        bidNumber: f.bidNumber.trim() || null,
      };
      if (!doc) id = await app.createBid(input);
      else {
        let milestones;
        try {
          milestones = stops.filter((s) => s.include && s.atLocal).map((s) => ({
            type: s.type, at: localToIso(s.atLocal, f.timezone), mandatory: s.mandatory, reminderOffsets: s.reminderOffsets,
          }));
        } catch {
          app.error = 'One of the milestone times looks wrong.';
          saving = false;
          return;
        }
        const contact = docContact && addContact
          ? { firstName: docContact.firstName, lastName: docContact.lastName, title: docContact.title, email: docContact.email, phone: docContact.phone, organization: f.agencyName.trim() }
          : null;
        const lines = $state.snapshot(doc.lines) as typeof doc.lines;
        const events = learningEvents($state.snapshot(f) as DocForm, $state.snapshot(sources) as typeof sources, $state.snapshot(stops) as SuggestedStop[]);
        id = await app.createBidFromDocument(input, details(), milestones, contact);
        // Learning runs after the bid is written and never holds up the form.
        if (id) void app.learnFromDocument(lines, events);
      }
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
          title: f.title.trim(),
          agencyName: f.agencyName.trim(),
          agencyType: f.agencyType,
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

<dialog bind:this={dialog} onclose={close} aria-labelledby="qa-title">
  <form onsubmit={save}>
    {#if app.error}
      <!-- The app's toast sits under the modal: show errors here while the form is open. -->
      <div class="err" role="alert">
        <span>{app.error}</span>
        <button type="button" class="btn small" onclick={() => (app.error = null)}>Dismiss</button>
      </div>
    {/if}
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
      <div class="docbar" class:busy={doc?.status === 'reading'} role="status">
        {#if doc}<span>{docNote}</span>{:else}<span class="hint">Have the RFP? Drop it on the window, or</span>{/if}
        {#if doc && doc.status !== 'reading'}<button type="button" class="btn small" onclick={() => app.openImportedFile()}>Open file</button>{/if}
        <button type="button" class="btn small" disabled={doc?.status === 'reading'} onclick={() => app.importDocumentFromPicker()}>
          {doc ? 'Fill from another document…' : 'Fill from document…'}
        </button>
      </div>

      <div class="sfield">
        <label class="field"><span>Bid title *</span><input bind:value={f.title} placeholder="Student Chromebooks" required /></label>
        <SuggestDot {...dot('title')} label="Bid title" />
      </div>
      <div class="sfield">
        <label class="field"><span>Agency *</span><input bind:value={f.agencyName} placeholder="Cedar Valley ISD" required /></label>
        <SuggestDot {...dot('agencyName')} label="Agency" />
      </div>
      <div class="grid2">
        <div class="sfield">
          <label class="field">
            <span>Agency type</span>
            <select bind:value={f.agencyType}>
              {#each Object.entries(AGENCY_TYPE_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
            </select>
          </label>
          <SuggestDot {...dot('agencyType')} label="Agency type" />
        </div>
        <div class="sfield">
          <label class="field">
            <span>Submission</span>
            <select bind:value={f.method}>
              {#each Object.entries(METHOD_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
            </select>
          </label>
          <SuggestDot {...dot('method')} label="Submission" />
        </div>
      </div>
      <div class="grid2">
        <div class="sfield">
          <label class="field">
            <span>Due date &amp; time *</span>
            <input type="datetime-local" bind:value={f.dueAtLocal} required />
          </label>
          <SuggestDot {...dot('dueAtLocal')} label="Due date" />
        </div>
        <div class="sfield">
          <label class="field">
            <span>Agency timezone</span>
            <select bind:value={f.timezone}>
              {#each tzs as tz (tz)}<option value={tz}>{tz}</option>{/each}
              {#if !tzs.includes(f.timezone)}<option value={f.timezone}>{f.timezone}</option>{/if}
            </select>
          </label>
          <SuggestDot {...dot('timezone')} label="Agency timezone" />
        </div>
      </div>
      <div class="grid2">
        <div class="sfield">
          <label class="field">
            <span>Est. value ($)</span>
            <input bind:value={f.estValue} inputmode="numeric" placeholder="480000" />
          </label>
          <SuggestDot {...dot('estValue')} label="Est. value" />
        </div>
        <div class="sfield">
          <label class="field">
            <span>Bid #</span>
            <input bind:value={f.bidNumber} placeholder="RFP 26-114" />
          </label>
          <SuggestDot {...dot('bidNumber')} label="Bid #" />
        </div>
      </div>

      {#if showDetails}
        <fieldset class="more">
          <legend>More from the document</legend>
          <div class="sfield">
            <label class="field"><span>Scope</span><textarea bind:value={f.scope}></textarea></label>
            <SuggestDot {...dot('scope')} label="Scope" />
          </div>
          {#if f.method === 'online'}
            <div class="grid2">
              <div class="sfield">
                <label class="field"><span>Portal name</span><input bind:value={f.portalName} placeholder="BidNet" /></label>
                <SuggestDot {...dot('portalName')} label="Portal name" />
              </div>
              <div class="sfield">
                <label class="field"><span>Portal URL</span><input bind:value={f.portalUrl} type="url" placeholder="https://" /></label>
                <SuggestDot {...dot('portalUrl')} label="Portal URL" />
              </div>
            </div>
          {:else if f.method === 'sealed'}
            <div class="sfield">
              <label class="field"><span>Delivery address</span><textarea bind:value={f.deliveryAddress}></textarea></label>
              <SuggestDot {...dot('deliveryAddress')} label="Delivery address" />
            </div>
            <div class="grid3">
              <div class="sfield">
                <label class="field"><span>Copies required</span><input bind:value={f.copiesRequired} inputmode="numeric" /></label>
                <SuggestDot {...dot('copiesRequired')} label="Copies required" />
              </div>
              <div class="sfield">
                <label class="field"><span>Ship method</span>
                  <select bind:value={f.shipMethod}>
                    <option value="">—</option>
                    {#each Object.entries(SHIP_METHOD_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
                  </select>
                </label>
                <SuggestDot {...dot('shipMethod')} label="Ship method" />
              </div>
              <div class="sfield">
                <label class="field"><span>Ship lead (days)</span><input type="number" min="0" max="10" bind:value={f.shipLeadBusinessDays} /></label>
                <SuggestDot {...dot('shipLeadBusinessDays')} label="Ship lead" />
              </div>
            </div>
            <div class="sfield">
              <label class="check"><input type="checkbox" bind:checked={f.notarizeRequired} /> Notarization required</label>
              <SuggestDot {...dot('notarizeRequired')} label="Notarization" />
            </div>
          {/if}

          <div class="sfield">
            <label class="check"><input type="checkbox" bind:checked={f.erate} /> E-Rate bid</label>
            <SuggestDot {...dot('erate')} label="E-Rate" />
          </div>
          {#if f.erate}
            <div class="grid3">
              <div class="sfield">
                <label class="field"><span>Form 470 #</span><input bind:value={f.erate470Number} inputmode="numeric" placeholder="270012345" /></label>
                <SuggestDot {...dot('erate470Number')} label="Form 470 number" />
              </div>
              <div class="sfield">
                <label class="field"><span>Funding year</span><input bind:value={f.erateFundingYear} inputmode="numeric" placeholder="2027" /></label>
                <SuggestDot {...dot('erateFundingYear')} label="Funding year" />
              </div>
              <div class="sfield">
                <label class="field"><span>Category</span>
                  <select bind:value={f.erateCategory}>
                    <option value="1">1</option><option value="2">2</option><option value="">Both</option>
                  </select>
                </label>
                <SuggestDot {...dot('erateCategory')} label="E-Rate category" />
              </div>
            </div>
          {/if}

          {#if stops.length}
            <div class="stops">
              <span class="sub">Milestones found</span>
              {#each stops as s (s.type)}
                <div class="stop sfield">
                  <label class="check"><input type="checkbox" bind:checked={s.include} /> {MILESTONE_TYPE_LABELS[s.type]}</label>
                  <input type="datetime-local" bind:value={s.atLocal} disabled={!s.include} aria-label="{MILESTONE_TYPE_LABELS[s.type]} date and time" />
                  {#if s.type === 'pre_bid' || s.type === 'site_walk'}
                    <label class="check"><input type="checkbox" bind:checked={s.mandatory} disabled={!s.include} /> Mandatory</label>
                  {/if}
                  <SuggestDot source={{ kind: 'doc', candidates: s.candidates }} label={MILESTONE_TYPE_LABELS[s.type]} value={s.atLocal} onpick={(c) => (s.atLocal = c.value)} />
                </div>
              {/each}
            </div>
          {/if}

          {#if docContact?.email}
            <label class="check offer">
              <input type="checkbox" bind:checked={addContact} />
              Add {contactName(docContact)}{docContact.title ? ` (${docContact.title})` : ''} as procurement contact?
              <span class="hint">{docContact.email}{docContact.phone ? ` · ${docContact.phone}` : ''}</span>
            </label>
          {/if}
        </fieldset>
      {/if}
    {:else}
      <label class="field">
        <span>Customer *</span>
        <input bind:value={f.agencyName} placeholder="Henrico County Public Schools" required />
      </label>
      <label class="field">
        <span>What they want *</span>
        <input bind:value={f.title} placeholder="Chromebook carts × 40" required />
      </label>
      <div class="grid2">
        <label class="field">
          <span>Agency type</span>
          <select bind:value={f.agencyType}>
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
  dialog { border: 0; border-radius: 16px; padding: 0; width: min(620px, calc(100vw - 32px)); max-height: calc(100vh - 48px); box-shadow: 0 24px 60px rgba(22, 32, 44, 0.25); }
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
  .sfield { position: relative; }
  .docbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 10px; border: 1px dashed var(--line); border-radius: 10px; font-size: 13px; }
  .docbar span { flex: 1; min-width: 0; }
  .docbar.busy { color: var(--muted); }
  .btn.small { height: 28px; padding: 0 10px; font-size: 12px; }
  .more { border: 1px solid var(--line-soft); border-radius: 12px; margin: 0; padding: 10px 14px 14px; display: flex; flex-direction: column; gap: 12px; }
  .more legend { font-size: 12px; font-weight: 600; color: var(--muted); padding: 0 4px; }
  .stops { display: flex; flex-direction: column; gap: 8px; }
  .sub { font-size: 12px; font-weight: 600; color: var(--muted); }
  .stop { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-right: 200px; }
  .stop input[type='datetime-local'] { height: 32px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; }
  .stop :global(.sug) { top: 6px; }
  .offer { align-items: flex-start; flex-wrap: wrap; }
  .err {
    position: sticky; top: 0; z-index: 70; display: flex; align-items: center; gap: 12px; padding: 10px 12px;
    background: #fff; border: 1px solid var(--red); border-radius: 10px; color: var(--red); font-size: 13px;
  }
  .err span { flex: 1; min-width: 0; }
  .offer .hint { width: 100%; padding-left: 24px; }
</style>
