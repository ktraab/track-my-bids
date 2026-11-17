<script lang="ts" module>
  let nextId = 0;
</script>

<script lang="ts">
  import { app } from '$lib/state.svelte';

  let { bidId, stopId = undefined, label = 'Add to calendar', compact = true }:
    { bidId: string; stopId?: string; label?: string; compact?: boolean } = $props();
  const id = `cal-${nextId++}`;
  const open = $derived(app.openMenuId === id);
  let root: HTMLDetailsElement | undefined = $state();

  function ontoggle(e: Event & { currentTarget: HTMLDetailsElement }) {
    if (e.currentTarget.open) app.openMenuId = id;
    else if (app.openMenuId === id) app.openMenuId = null;
  }
  function close(refocus: boolean) {
    app.openMenuId = null;
    if (refocus) root?.querySelector('summary')?.focus();
  }

  // Outside-click / Escape handling only while this menu is open.
  $effect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (root && !root.contains(e.target as Node)) close(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(true); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  });

  async function go(target: 'google' | 'outlook' | 'outlook_personal' | 'file') {
    close(false);
    await app.addToCalendar(target, bidId, stopId);
  }
</script>

<details class="cal" bind:this={root} {open} {ontoggle}>
  <summary class:btn={!compact} class:icon={compact} aria-label={label} title={label}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4M8 2v4M3 10h18"></path></svg>
    {#if !compact}<span>{label}</span>{/if}
  </summary>
  <div class="menu">
    {#if stopId}
      <button onclick={() => go('google')}>Google Calendar</button>
      <button onclick={() => go('outlook')}>Outlook (work / school)</button>
      <button onclick={() => go('outlook_personal')}>Outlook.com (personal)</button>
    {/if}
    <button onclick={() => go('file')}>{stopId ? 'Calendar app (Outlook desktop, Apple)' : 'Open all in calendar app (.ics)'}</button>
  </div>
</details>

<style>
  .cal { position: relative; }
  summary { list-style: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; }
  summary::-webkit-details-marker { display: none; }
  .menu {
    position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 260px;
    background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 6px;
    box-shadow: 0 12px 30px rgba(22, 32, 44, 0.15); display: flex; flex-direction: column;
  }
  .menu button { text-align: left; background: none; border: 0; padding: 8px 10px; border-radius: 6px; }
  .menu button:hover, .menu button:focus-visible { background: var(--bg); }
</style>
