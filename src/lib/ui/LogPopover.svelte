<script lang="ts">
  import { tick } from 'svelte';
  import type { BidWithChildren } from '$lib/domain/types';
  import TouchComposer from './TouchComposer.svelte';

  /** Quick "+ Log" popover from a map row: fixed position, clamped to the window (same technique as Needs you). */
  let { data, anchor, onClose }: { data: BidWithChildren; anchor: DOMRect; onClose: () => void } = $props();

  const WIDTH = 360;
  let pop: HTMLDivElement | undefined = $state();
  let height = $state(380);
  const place = $derived.by(() => {
    const width = Math.min(WIDTH, window.innerWidth - 16);
    const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
    const below = window.innerHeight - anchor.bottom - 8;
    const above = anchor.top - 8;
    const flip = below < height + 8 && above > below;
    const top = flip ? Math.max(8, anchor.top - 8 - height) : anchor.bottom + 8;
    return { left, top, width, maxH: Math.max(200, flip ? above : below) };
  });

  $effect(() => {
    void tick().then(() => pop?.querySelector<HTMLElement>('.chip.on')?.focus());
  });
  function onPointer(e: PointerEvent) {
    if (!pop || !(e.target instanceof Node) || pop.contains(e.target)) return;
    if ((e.target as Element).closest?.('.log')) return; // the + Log button toggles us itself
    onClose();
  }
</script>

<svelte:window onpointerdown={onPointer} onresize={onClose} />

<div bind:this={pop} class="pop" role="dialog" aria-label="Log a touch: {data.bid.agencyName}" bind:clientHeight={height}
  style:left="{place.left}px" style:top="{place.top}px" style:width="{place.width}px" style:max-height="{place.maxH}px">
  <div class="h"><strong>{data.bid.agencyName}</strong> · {data.bid.title}</div>
  <TouchComposer {data} onSaved={onClose} {onClose} />
</div>

<style>
  .pop {
    position: fixed; z-index: 45; overflow-y: auto; padding: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.14), 0 2px 6px rgb(0 0 0 / 0.06); display: flex; flex-direction: column; gap: 8px;
  }
  .h { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .h strong { color: var(--ink); }
</style>
