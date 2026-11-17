<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { CONTACT_ROLE_LABELS, contactName, matchesContact } from '$lib/domain/contacts';
  import ContactEditor from './ContactEditor.svelte';
  import ExportDialog from './ExportDialog.svelte';

  let query = $state('');
  let editing = $state<string | null>(null);
  let confirmDelete = $state<string | null>(null);
  let exporting = $state(false);
  $effect(() => { void query; editing = null; });
  const list = $derived(app.contactList.filter((c) => matchesContact(c.contact, query)));
</script>

<section class="page">
  <div class="topbar">
    <button class="btn" onclick={() => app.home()}>‹ Network</button>
    <h1>Contacts</h1>
    <div class="spacer"></div>
    <button class="btn primary" onclick={() => (exporting = true)}>Export report…</button>
  </div>

  <input class="search" bind:value={query} placeholder="Search name, email, organization, title" aria-label="Search contacts" />

  <div class="card table-wrap">
    <table>
      <thead><tr><th>Name</th><th>Title</th><th>Organization</th><th>Email</th><th>Phone</th><th>Bids</th><th><span class="sr">Actions</span></th></tr></thead>
      <tbody>
        {#each list as c (c.contact.id)}
          {#if editing === c.contact.id}
            <tr><td colspan="7" class="editing">
              <ContactEditor initial={c.contact} onSubmit={async (x) => { const ok = await app.updateContact(c.contact.id, x); if (ok) editing = null; return ok; }} onCancel={() => (editing = null)} />
            </td></tr>
          {:else}
            <tr>
              <td><strong>{contactName(c.contact)}</strong></td>
              <td>{c.contact.title ?? ''}</td>
              <td>{c.contact.organization ?? ''}</td>
              <td>{c.contact.email ?? ''}</td>
              <td>{c.contact.phone ?? ''}</td>
              <td>
                <div class="bids">
                {#each c.bids as b (b.linkId)}
                  <button class="chip" onclick={() => app.open(b.bidId)} title={b.title}>{b.agencyName} · {CONTACT_ROLE_LABELS[b.role]}</button>
                {/each}
                </div>
              </td>
              <td class="row-actions">
                <button class="btn small" onclick={() => (editing = c.contact.id)}>Edit</button>
                {#if confirmDelete === c.contact.id}
                  <button class="btn small" onclick={() => (confirmDelete = null)}>Keep</button>
                  <button class="btn small danger" onclick={() => { void app.removeContact(c.contact.id); confirmDelete = null; }}>Remove{c.bids.length ? ` (from ${c.bids.length} bid${c.bids.length === 1 ? '' : 's'})` : ''}</button>
                {:else}
                  <button class="btn small danger" onclick={() => (confirmDelete = c.contact.id)}>Delete</button>
                {/if}
              </td>
            </tr>
          {/if}
        {:else}
          <tr><td colspan="7" class="empty">{app.contactList.length ? 'No contacts match your search.' : 'No contacts yet. Add them from a bid’s Contacts card.'}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="card box data">
    <h2>Your data</h2>
    <p class="hint">Back up everything to one file. Restoring merges a backup into this computer: newer edits win, nothing is deleted.</p>
    <div class="row">
      <button class="btn" onclick={() => app.showImport()}>Import from Outlook…</button>
      <button class="btn" disabled={app.restoring} onclick={() => app.backupAll()}>Back up all data…</button>
      <button class="btn" disabled={app.restoring || app.team.mode === 'team'} title={app.team.mode === 'team' ? 'Turned off while connected to a team' : undefined} onclick={() => app.restoreBackup()}>{app.restoring ? 'Restoring…' : 'Restore from backup…'}</button>
    </div>
  </div>

  {#if exporting}<ExportDialog onClose={() => (exporting = false)} />{/if}
</section>

<style>
  .topbar { display: flex; align-items: center; gap: 12px; }
  .topbar h1 { font-size: 28px; }
  .spacer { flex: 1; }
  .search { height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 10px; max-width: 420px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 760px; }
  th { text-align: left; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); padding: 12px 14px; border-bottom: 1px solid var(--line); }
  td { overflow-wrap: anywhere; padding: 10px 14px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  .bids { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { font-size: 12px; padding: 3px 8px; border-radius: 12px; border: 1px solid var(--line); background: #fff; }
  .chip:hover { border-color: var(--ink-2); }
  .row-actions { white-space: nowrap; overflow-wrap: normal; text-align: right; }
  .btn.small { height: 30px; padding: 0 10px; font-size: 12px; }
  .editing { background: var(--bg); }
  .empty { color: var(--muted); text-align: center; padding: 28px; }
  .data .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
