<script lang="ts">
  import type { LayoutLine } from '$lib/domain/transitLayout';

  let { line, height = 104, todayPct = null }: { line: LayoutLine; height?: number; todayPct?: number | null } = $props();
  const mid = $derived(height / 2);
</script>

<div class="track" style:height="{height}px" style:--c={line.color}>
  {#if line.pastSeg}
    <div class="seg past" style:top="{mid - 3}px" style:left="{line.pastSeg.fromPct}%" style:width="{line.pastSeg.toPct - line.pastSeg.fromPct}%"></div>
  {/if}
  {#if line.futureSeg}
    <div class="seg future" style:top="{mid - 3}px" style:left="{line.futureSeg.fromPct}%" style:width="{line.futureSeg.toPct - line.futureSeg.fromPct}%"></div>
  {/if}
  {#if todayPct !== null}
    <div class="today" style:left="{todayPct}%"></div>
  {/if}
  {#each line.stops as s (s.id)}
    <div class="stop {s.kind}" class:past={s.past} role="img" title={s.tooltip} aria-label={s.tooltip} style:left="{s.pct}%" style:top="{mid}px"></div>
    <div
      class="label"
      class:mand={s.kind === 'mandatory'}
      class:past={s.past}
      style:left="{s.pct}%"
      style:transform={s.pct < 8 ? 'none' : s.pct > 92 ? 'translateX(-100%)' : null}
      style:top={s.labelBelow ? `${mid + 16}px` : `${mid - 44}px`}
    >
      <strong>{s.label}</strong>
      <span>{s.dateLabel}</span>
    </div>
  {/each}
</div>

<style>
  .track { position: relative; flex: 1; min-width: 0; }
  .seg { position: absolute; height: 6px; border-radius: 3px; }
  .seg.past { background: #c9d1db; }
  .seg.future { background: var(--c); }
  .today { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--red); opacity: 0.5; }
  .stop {
    position: absolute; transform: translate(-50%, -50%);
    width: 16px; height: 16px; border-radius: 50%; background: #fff; border: 4px solid var(--c);
  }
  .stop.past { border-color: var(--past); }
  .stop.terminus { width: 22px; height: 18px; border-radius: 4px; border: 0; background: var(--ink); }
  .stop.mandatory { width: 22px; height: 22px; border: 0; background: var(--ink); box-shadow: 0 0 0 3px #fff, 0 0 0 5px var(--red); }
  .stop.shipby { width: 16px; height: 16px; border-radius: 3px; transform: translate(-50%, -50%) rotate(45deg); }
  .stop.terminus.past, .stop.mandatory.past { background: var(--past); }
  .label {
    position: absolute; transform: translateX(-50%); white-space: nowrap; text-align: center;
    font-size: 11px; line-height: 1.25; display: flex; flex-direction: column; color: var(--ink);
  }
  .label strong { letter-spacing: 0.04em; }
  .label.mand { color: var(--red); }
  .label.past { color: #6b7785; }
</style>
