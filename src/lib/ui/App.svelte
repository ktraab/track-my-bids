<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { openTauriSql } from '$lib/db/tauriSql';
  import TransitMap from './TransitMap.svelte';
  import BidDetail from './BidDetail.svelte';
  import QuickAdd from './QuickAdd.svelte';
  import NotificationsPanel from './NotificationsPanel.svelte';
  import DigestPanel from './DigestPanel.svelte';
  import ContactsScreen from './ContactsScreen.svelte';
  import SettingsScreen from './SettingsScreen.svelte';
  import ImportScreen from './ImportScreen.svelte';
  import { startRuntime } from '$lib/notify/runtime';

  const bidId = $derived(app.view.name === 'bid' ? app.view.id : null);

  onMount(() => {
    void app.init(openTauriSql);
  });

  // Start the runtime whenever the store becomes ready (including after Retry). startRuntime is idempotent.
  $effect(() => {
    if (app.ready) startRuntime().catch((e) => console.error('[runtime]', e));
  });

  // Auto-dismiss notices that have no file to reveal.
  $effect(() => {
    const n = app.notice;
    if (!n || n.path) return;
    const t = setTimeout(() => { if (app.notice === n) app.notice = null; }, 6000);
    return () => clearTimeout(t);
  });

  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && app.ready) {
      e.preventDefault();
      app.quickAddOpen = true;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if app.error}
  <div class="toast" role="alert">
    <span>{app.error}</span>
    {#if app.needsRetry}<button class="btn" onclick={() => app.retryInit()}>Retry</button>{/if}
    <button class="btn" onclick={() => (app.error = null)}>Dismiss</button>
  </div>
{/if}

{#if app.notice}
  <div class="notice" role="status">
    <span>{app.notice.text}</span>
    {#if app.notice.path}<button class="btn" onclick={() => app.revealNotice()}>Show file</button>{/if}
    <button class="btn" onclick={() => (app.notice = null)}>OK</button>
  </div>
{/if}

{#if app.ready && app.view.name !== 'network'}
  <nav class="appbar" aria-label="App">
    <button class="home" onclick={() => app.home()}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9.5V21h5v-6h4v6h5V9.5"></path></svg>
      Home
    </button>
  </nav>
{/if}

{#if !app.ready}
  <p class="loading">Loading…</p>
{:else if bidId}
  {#key bidId}<BidDetail id={bidId} />{/key}
{:else if app.view.name === 'contacts'}
  <ContactsScreen />
{:else if app.view.name === 'import'}
  <ImportScreen />
{:else if app.view.name === 'settings'}
  <SettingsScreen />
{:else}
  <TransitMap />
{/if}

{#if app.quickAddOpen}
  <QuickAdd />
{/if}

{#if app.panel === 'inbox'}
  <NotificationsPanel />
{:else if app.panel === 'digest'}
  <DigestPanel />
{/if}

<style>
  .toast {
    position: fixed; right: 20px; bottom: 20px; z-index: 50; max-width: min(460px, calc(50vw - 30px));
    display: flex; gap: 12px; align-items: center; padding: 12px 14px;
    background: #fff; border: 1px solid var(--red); border-radius: 12px; color: var(--red);
    box-shadow: 0 8px 24px rgba(22, 32, 44, 0.15);
  }
  .notice { position: fixed; left: 20px; bottom: 20px; z-index: 50; max-width: min(460px, calc(50vw - 30px)); display: flex; gap: 12px; align-items: center; padding: 12px 14px; background: #fff; border: 1px solid #b7d7c0; border-radius: 12px; color: #1d5c2e; box-shadow: 0 8px 24px rgba(22, 32, 44, 0.15); }
  .loading { padding: 40px; color: var(--muted); }
  .appbar {
    position: sticky; top: 0; z-index: 30; display: flex; align-items: center;
    padding: 8px 32px; background: rgba(243, 245, 248, 0.92); backdrop-filter: blur(6px);
    border-bottom: 1px solid var(--line);
  }
  .home {
    display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px;
    border-radius: 18px; border: 1px solid var(--line); background: var(--card); color: var(--ink); font-weight: 600;
  }
  .home:hover { border-color: var(--ink-2); }
</style>
