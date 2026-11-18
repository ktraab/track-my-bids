<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { ROLE_LABELS, syncLabel, syncTone } from '$lib/sync/statusText';
  import { formatDateTime } from '$lib/domain/time';
  import type { Role } from '$lib/sync/types';

  let code = $state('');
  let serverUrl = $state('');
  let serverKey = $state('');
  let showServer = $state(false);
  let email = $state('');
  let password = $state('');
  let displayName = $state('');
  let creating = $state(false);
  let busy = $state(false);
  let info = $state<string | null>(null);
  let confirmLeave = $state(false);
  let confirmRemove = $state<string | null>(null);
  // Bids (open, closed and trashed) that will move to the admin. Counted from this computer's copy.
  const ownedCount = (id: string) => app.bids.filter((d) => d.bid.ownerId === id).length + app.trash.filter((b) => b.ownerId === id).length;

  const t = $derived(app.team);
  const isAdmin = $derived(t.mode === 'team' && t.me?.role === 'admin' && !!t.me?.active);
  const needsSignIn = $derived(t.mode === 'joining' || (t.mode === 'team' && t.sync.status === 'signed_out'));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Reload the trash whenever bids change (a delete here, or one pulled from the team).
  $effect(() => {
    void app.bids;
    if (isAdmin) void app.loadTrash();
  });

  async function run(fn: () => Promise<unknown>) {
    busy = true;
    info = null;
    try { await fn(); } finally { busy = false; }
  }

  function submitAuth(e: SubmitEvent) {
    e.preventDefault();
    void run(async () => {
      if (creating) {
        const r = await app.teamSignUp(email, password, displayName);
        if (r === 'confirm_email') {
          creating = false;
          info = 'Check your email to confirm the account, then sign in here.';
        }
      } else {
        await app.teamSignIn(email, password);
      }
      password = '';
    });
  }
</script>

<div class="card box team">
  <h2>Team</h2>

  {#if t.mode === 'local'}
    <p class="hint">Your bids are stored on this computer only. To share bids with your team, paste the join code your admin sent you.</p>
    <form class="inline" onsubmit={(e) => { e.preventDefault(); void run(() => app.teamJoin(code)); }}>
      <label class="field grow"><span>Join code</span><input bind:value={code} placeholder="tmb1.…" autocomplete="off" spellcheck="false" /></label>
      <button class="btn primary" type="submit" disabled={busy || !code.trim()}>Continue</button>
    </form>
    <button class="linkish self-start" onclick={() => (showServer = !showServer)}>{showServer ? 'Hide server setup' : 'Setting up a new team server?'}</button>
    {#if showServer}
      <p class="hint">Paste the Project URL and the publishable (or anon) key from Supabase → Project Settings → API. Never paste the secret key. See docs/TEAM-SETUP.md.</p>
      <form class="stack" onsubmit={(e) => { e.preventDefault(); void run(() => app.teamJoinServer(serverUrl, serverKey)); }}>
        <label class="field"><span>Project URL</span><input bind:value={serverUrl} placeholder="https://xxxx.supabase.co" autocomplete="off" spellcheck="false" /></label>
        <label class="field"><span>Public key</span><input bind:value={serverKey} autocomplete="off" spellcheck="false" /></label>
        <button class="btn self-start" type="submit" disabled={busy || !serverUrl.trim() || !serverKey.trim()}>Continue</button>
      </form>
    {/if}

  {:else if needsSignIn}
    {#if t.mode === 'team'}<p class="err">Your sign-in expired. Sign in again to keep syncing — your changes are saved on this computer.</p>{/if}
    <form class="stack" onsubmit={submitAuth}>
      {#if creating}
        <label class="field"><span>Your name</span><input bind:value={displayName} autocomplete="name" required /></label>
      {/if}
      <label class="field"><span>Email</span><input type="email" bind:value={email} autocomplete="email" required /></label>
      <label class="field"><span>Password</span><input type="password" bind:value={password} autocomplete={creating ? 'new-password' : 'current-password'} minlength="8" required /></label>
      <div class="inline">
        <button class="btn primary" type="submit" disabled={busy}>{creating ? 'Create account' : 'Sign in'}</button>
        <button class="linkish" type="button" onclick={() => (creating = !creating)}>{creating ? 'I already have an account' : 'Create an account'}</button>
        <span class="grow"></span>
        {#if t.mode === 'joining'}
          <button class="btn" type="button" disabled={busy} onclick={() => run(() => app.teamDisconnect())}>Cancel</button>
        {/if}
      </div>
    </form>
    {#if creating}<p class="hint">New accounts wait for an admin to approve them. The very first account on a new server becomes the admin.</p>{/if}
    {#if info}<p class="hint">{info}</p>{/if}
    {#if t.mode === 'team'}{@render leave()}{/if}

  {:else}
    <div class="status">
      <i class="dot {syncTone(t.sync)}"></i>
      <span>{syncLabel(t.sync, app.nowMs)}</span>
      <button class="btn small" disabled={t.sync.status === 'syncing'} onclick={() => app.teamSyncNow()}>Sync now</button>
    </div>
    <p class="hint">Signed in as {t.me?.displayName || t.me?.email || '…'}{t.me ? ` · ${ROLE_LABELS[t.me.role]}` : ''}</p>

    {#if isAdmin}
      <h3>Members</h3>
      <ul class="rows">
        {#each t.members as m (m.id)}
          <li>
            <span class="who"><strong>{m.displayName || m.email}</strong><small>{m.email}</small></span>
            <select class="ctl" value={m.role} disabled={busy || m.id === t.userId} aria-label="Role for {m.displayName || m.email}"
              onchange={(e) => { const el = e.currentTarget; void run(async () => { if (!(await app.teamSetMember(m.id, el.value as Role, m.active))) el.value = m.role; }); }}>
              <option value="pending">Waiting</option>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <label class="check"><input type="checkbox" checked={m.active} disabled={busy || m.id === t.userId}
              onchange={(e) => { const el = e.currentTarget; void run(async () => { if (!(await app.teamSetMember(m.id, m.role, el.checked))) el.checked = m.active; }); }} /> Active</label>
            {#if m.id !== t.userId && confirmRemove !== m.id}
              <button class="btn small" disabled={busy} onclick={() => (confirmRemove = m.id)}>Remove…</button>
            {/if}
          </li>
          {#if confirmRemove === m.id}
            {@const n = ownedCount(m.id)}
            <li class="confirm" role="group" aria-label="Confirm removing {m.displayName || m.email}">
              <span class="hint">Remove {m.displayName || m.email}? {n ? `Their ${n} bid${n === 1 ? '' : 's'} move to you. ` : ''}They lose access right away and would have to sign up again to rejoin. Bids already on their computer stay there.</span>
              <button class="btn danger" disabled={busy} onclick={() => run(async () => { if (await app.teamRemoveMember(m.id)) confirmRemove = null; })}>Remove</button>
              <button class="btn" disabled={busy} onclick={() => (confirmRemove = null)}>Cancel</button>
            </li>
          {/if}
        {/each}
      </ul>

      <h3>Join code</h3>
      <p class="hint">Send this to a teammate. They paste it in Settings → Team and create an account for you to approve.</p>
      <div class="inline">
        <input class="ctl grow mono" readonly value={t.joinCode ?? ''} aria-label="Join code" onfocus={(e) => e.currentTarget.select()} />
        <button class="btn" onclick={() => app.copyJoinCode()}>Copy</button>
      </div>

      <h3>Trash</h3>
      {#if app.trash.length === 0}
        <p class="hint">No deleted bids.</p>
      {:else}
        <ul class="rows">
          {#each app.trash as b (b.id)}
            <li>
              <span class="who"><strong>{b.agencyName} · {b.title}</strong><small>Deleted {b.deletedAt ? formatDateTime(b.deletedAt, zone) : ''}</small></span>
              <button class="btn small" disabled={busy} onclick={() => run(() => app.restoreBid(b.id))}>Restore</button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    {@render leave()}
  {/if}
</div>

{#snippet leave()}
  <div class="leave">
    {#if confirmLeave}
      <span class="hint">{t.sync.pending ? `${t.sync.pending} change${t.sync.pending === 1 ? '' : 's'} haven’t synced and will stay only on this computer. ` : ''}Your bids stay on this computer.</span>
      <button class="btn danger" disabled={busy} onclick={() => run(async () => { await app.teamDisconnect(); confirmLeave = false; })}>Leave team</button>
      <button class="btn" onclick={() => (confirmLeave = false)}>Cancel</button>
    {:else}
      <button class="btn" onclick={() => (confirmLeave = true)}>Leave team…</button>
    {/if}
  </div>
{/snippet}

<style>
  h3 { margin: 8px 0 0; font-size: 15px; }
  .inline { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .stack { display: flex; flex-direction: column; gap: 8px; max-width: 420px; }
  .grow { flex: 1; min-width: 200px; }
  .self-start { align-self: flex-start; }
  .ctl { height: 36px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; font: inherit; color: var(--ink); background: #fff; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .status { display: flex; gap: 10px; align-items: center; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #9aa5b1; }
  .dot.ok { background: #2f9e57; }
  .dot.busy { background: #2f7de1; }
  .dot.bad { background: var(--red); }
  .btn.small { height: 32px; padding: 0 12px; font-size: 13px; }
  .rows { list-style: none; margin: 0; padding: 0; }
  .rows li { display: flex; gap: 12px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line-soft, #eef1f5); }
  .who { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .who small { color: var(--muted); }
  .rows li.confirm { border-top: none; padding-top: 0; flex-wrap: wrap; }
  .rows li.confirm .hint { flex: 1 1 100%; }
  .err { margin: 0; color: var(--red); font-size: 13px; }
  .leave { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
</style>
