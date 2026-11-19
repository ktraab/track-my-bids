<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    id,
    title,
    summary = '',
    badge = '',
    open = false,
    ontoggle,
    children,
  }: {
    id: string;
    title: string;
    summary?: string;
    badge?: string;
    open?: boolean;
    ontoggle: (id: string) => void;
    children: Snippet;
  } = $props();
</script>

<div class="card section" class:open>
  <h2 class="h">
    <button type="button" class="toggle" aria-expanded={open} aria-controls="settings-{id}" onclick={() => ontoggle(id)}>
      <span class="title">{title}</span>
      {#if badge}<span class="badge">{badge}</span>{/if}
      {#if summary && !open}<span class="summary">{summary}</span>{/if}
      <span class="chev" aria-hidden="true">›</span>
    </button>
  </h2>
  <div id="settings-{id}" class="body" hidden={!open}>
    {@render children()}
  </div>
</div>

<style>
  .section { overflow: hidden; }
  .h { margin: 0; font-size: inherit; }
  .toggle {
    width: 100%; display: flex; align-items: center; gap: 12px;
    padding: 14px 18px; border: 0; background: transparent; cursor: pointer;
    font: inherit; color: var(--ink); text-align: left;
  }
  .toggle:hover { background: var(--line-soft); }
  .toggle:focus-visible { outline: 2px solid var(--accent, #2f7de1); outline-offset: -2px; }
  .title { font-size: 17px; font-weight: 650; }
  .summary { flex: 1; min-width: 0; color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 11px; font-weight: 600; color: #8a5a00; background: #fff3d6; border-radius: 10px; padding: 2px 8px; }
  .chev { margin-left: auto; color: var(--muted); font-size: 20px; line-height: 1; transition: transform 0.15s; }
  .open .chev { transform: rotate(90deg); }
  .open .toggle { border-bottom: 1px solid var(--line-soft); }
  .body { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
  .body[hidden] { display: none; }
</style>
