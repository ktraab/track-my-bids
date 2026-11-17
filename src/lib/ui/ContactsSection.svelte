<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { app } from '$lib/state.svelte';
  import type { BidWithChildren, ContactRole } from '$lib/domain/types';
  import { CONTACT_ROLE_LABELS, contactName, matchesContact, type ContactInput } from '$lib/domain/contacts';
  import ContactEditor from './ContactEditor.svelte';

  let { data }: { data: BidWithChildren } = $props();
  let mode = $state<'idle' | 'new' | 'pick'>('idle');
  let role = $state<ContactRole>('procurement');
  let query = $state('');
  const roles = Object.entries(CONTACT_ROLE_LABELS) as [ContactRole, string][];
  const linkedIds = $derived(new Set(data.contacts.map((c) => c.contact.id)));
  const matches = $derived(
    query.trim()
      ? app.contactList.filter((c) => !linkedIds.has(c.contact.id) && matchesContact(c.contact, query)).slice(0, 8)
      : [],
  );

  async function addNew(input: ContactInput) {
    const organization = input.organization?.trim() ? input.organization : data.bid.agencyName;
    const ok = await app.addContactToBid(data.bid.id, { ...input, organization }, role);
    if (ok) mode = 'idle';
    return ok;
  }
  async function pick(contactId: string) {
    if (await app.linkContact(data.bid.id, contactId, role)) {
      query = '';
      mode = 'idle';
    }
  }
  async function changeRole(e: Event & { currentTarget: HTMLSelectElement }, linkId: string, current: ContactRole) {
    const el = e.currentTarget;
    if (!(await app.setContactRole(linkId, el.value as ContactRole))) el.value = current;
  }
  const go = (url: string) => openUrl(url).catch((e) => (app.error = String(e)));
</script>

<section class="card box">
  <div class="head">
    <h2>Contacts</h2>
    <div class="tools">
      <button class="btn" onclick={() => (mode = mode === 'new' ? 'idle' : 'new')}>+ New</button>
      <button class="btn" onclick={() => (mode = mode === 'pick' ? 'idle' : 'pick')} disabled={!app.contactList.length}>Link existing</button>
    </div>
  </div>

  {#if data.contacts.length}
    <ul>
      {#each data.contacts as bc (bc.linkId)}
        <li>
          <div class="who">
            <strong>{contactName(bc.contact)}</strong>
            <span class="meta">{[bc.contact.title, bc.contact.organization].filter(Boolean).join(' · ')}</span>
            <span class="meta">
              {#if bc.contact.email}<button class="linkish" onclick={() => go(`mailto:${bc.contact.email}`)}>{bc.contact.email}</button>{/if}
              {#if bc.contact.phone}<button class="linkish" onclick={() => go(`tel:${bc.contact.phone}`)}>{bc.contact.phone}</button>{/if}
            </span>
          </div>
          <select aria-label="Role for {contactName(bc.contact)}" value={bc.role} onchange={(e) => changeRole(e, bc.linkId, bc.role)}>
            {#each roles as [value, label] (value)}<option {value}>{label}</option>{/each}
          </select>
          <button class="icon" aria-label="Remove {contactName(bc.contact)} from this bid" onclick={() => app.unlinkContact(bc.linkId)}>✕</button>
        </li>
      {/each}
    </ul>
  {:else if mode === 'idle'}
    <p class="hint">No contacts yet. Add the procurement officer and the end user.</p>
  {/if}

  {#if mode !== 'idle'}
    <label class="field role"><span>Role on this bid</span>
      <select bind:value={role}>{#each roles as [value, label] (value)}<option {value}>{label}</option>{/each}</select>
    </label>
  {/if}
  {#if mode === 'new'}
    <ContactEditor submitLabel="Add contact" initial={{ organization: data.bid.agencyName }} onSubmit={addNew} onCancel={() => (mode = 'idle')} />
  {:else if mode === 'pick'}
    <input class="search" bind:value={query} placeholder="Search name, email, organization" aria-label="Search contacts" />
    <ul class="matches">
      {#each matches as m (m.contact.id)}
        <li><button class="linkish" onclick={() => pick(m.contact.id)}>{contactName(m.contact)}{m.contact.organization ? ` · ${m.contact.organization}` : ''}</button></li>
      {:else}
        {#if query.trim()}<li class="hint">No matches. Use “+ New” instead.</li>{/if}
      {/each}
    </ul>
  {/if}
</section>

<style>
  .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .tools { display: flex; gap: 6px; }
  .tools .btn { height: 34px; padding: 0 12px; font-size: 13px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line-soft); }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .who strong, .meta { min-width: 0; overflow-wrap: anywhere; }
  .linkish { overflow-wrap: anywhere; text-align: left; min-width: 0; max-width: 100%; }
  select { flex-shrink: 0; }
  .meta { font-size: 12px; color: var(--ink-2); display: flex; gap: 10px; flex-wrap: wrap; }
  select { height: 32px; border: 1px solid var(--line); border-radius: 8px; padding: 0 6px; background: #fff; }
  .role { max-width: 220px; }
  .search { height: 36px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; }
  .matches li { border: 0; padding: 4px 0; }
</style>
