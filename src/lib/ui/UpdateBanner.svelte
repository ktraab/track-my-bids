<script lang="ts">
  import { updater } from '$lib/update';
</script>

{#if updater.showBanner}
  <div class="update" role="status">
    {#if updater.status === 'installing'}
      <span>Downloading TrackMyBids {updater.version}{updater.progress !== null ? ` — ${Math.round(updater.progress * 100)}%` : '…'}</span>
    {:else if updater.status === 'restarting'}
      <span>Restarting…</span>
    {:else}
      <div class="text">
        <strong>TrackMyBids {updater.version} is available</strong>
        {#if updater.error}<span class="err">{updater.error}</span>{:else}<span class="hint">Restarts the app. Your bids and settings stay as they are.</span>{/if}
      </div>
      <button class="btn primary" onclick={() => updater.install()}>{updater.error ? 'Try again' : 'Update & restart'}</button>
      <button class="btn" onclick={() => updater.dismiss()}>Later</button>
    {/if}
  </div>
{/if}

<style>
  .update {
    display: flex; gap: 12px; align-items: center; padding: 12px 14px;
    background: #fff; border: 1px solid var(--line); border-radius: 12px; color: var(--ink);
    box-shadow: 0 8px 24px rgba(22, 32, 44, 0.15);
  }
  .text { display: flex; flex-direction: column; gap: 2px; }
  .hint { color: var(--muted); font-size: 13px; }
  .err { color: var(--red); font-size: 13px; }
</style>
