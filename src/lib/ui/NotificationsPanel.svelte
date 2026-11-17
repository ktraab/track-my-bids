<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { formatDateTime } from '$lib/domain/time';
  import { openNotificationSettings } from '$lib/notify/notifier';

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    dialog?.showModal();
  });

  async function openSettings() {
    try {
      await openNotificationSettings();
    } catch (e) {
      app.error = `Couldn't open settings: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function openBid(id: string) {
    app.open(id);
    dialog?.close();
  }
</script>

<dialog bind:this={dialog} class="drawer" onclose={() => (app.panel = null)} aria-labelledby="inbox-title">
  <header>
    <h2 id="inbox-title">Notifications</h2>
    <div class="actions">
      <button class="btn" onclick={() => app.markAllRead()} disabled={app.unread === 0}>Mark all read</button>
      <button class="icon" aria-label="Close" onclick={() => dialog?.close()}>✕</button>
    </div>
  </header>
  <p class="help">
    Not seeing desktop notifications?
    <button class="linkbtn" onclick={openSettings}>Open notification settings</button>
  </p>
  <ul>
    {#each app.notifications as n (n.key)}
      <li class:unread={!n.read}>
        <div class="when">{formatDateTime(n.firedAt, zone)}</div>
        <strong>{n.title}</strong>
        <p>{n.body}</p>
        <div class="row">
          {#if n.bidId}<button class="btn" onclick={() => openBid(n.bidId!)}>Open bid</button>{/if}
          {#if n.kind === 'reminder' || n.kind === 'shipby'}
            {#if app.canSnooze(n.key, 'hour')}
              <button class="btn" onclick={() => app.snooze(n.key, 'hour')}>Snooze 1 h</button>
            {/if}
            {#if app.canSnooze(n.key, 'tomorrow')}
              <button class="btn" onclick={() => app.snooze(n.key, 'tomorrow')}>Tomorrow morning</button>
            {/if}
          {/if}
          {#if n.kind === 'digest'}<button class="btn" onclick={() => (app.panel = 'digest')}>View briefing</button>{/if}
        </div>
        {#if n.snoozedUntil}<div class="hint">Snoozed until {formatDateTime(n.snoozedUntil, zone)}</div>{/if}
      </li>
    {:else}
      <li class="empty">No notifications yet. Your first briefing arrives at {app.notificationSettings.digestTimes[0] ?? '—'} on weekdays.</li>
    {/each}
  </ul>
</dialog>

<style>
  .drawer { margin: 0 0 0 auto; height: 100vh; max-height: 100vh; width: min(440px, 100vw); border: 0; padding: 0; box-shadow: -12px 0 40px rgba(22, 32, 44, 0.2); }
  .drawer::backdrop { background: rgba(22, 32, 44, 0.25); }
  header { position: sticky; top: 0; background: #fff; display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-bottom: 1px solid var(--line); }
  .actions { display: flex; gap: 6px; align-items: center; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 14px 18px; border-bottom: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 4px; }
  li.unread { background: #f4f8ff; }
  li p { margin: 0; color: var(--ink-2); white-space: pre-line; }
  .when { font-size: 12px; color: var(--muted); }
  .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .row .btn { height: 32px; padding: 0 12px; font-size: 13px; }
  .empty { color: var(--muted); }
  .help { margin: 0; padding: 8px 18px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--line-soft); }
  .linkbtn { background: none; border: 0; padding: 0; color: var(--ink-2); text-decoration: underline; font: inherit; cursor: pointer; }
</style>
