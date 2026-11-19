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
  {#each line.holderSegs as s, i (i)}
    <div class="seg thin {s.holder}" style:top="{mid - 2}px" style:left="{s.fromPct}%" style:width="{s.toPct - s.fromPct}%"></div>
  {/each}
  {#if line.ghostSeg}
    <div class="ghost" style:top="{mid - 1}px" style:left="{line.ghostSeg.fromPct}%" style:width="{line.ghostSeg.toPct - line.ghostSeg.fromPct}%"></div>
  {/if}
  {#if line.clipLabel}
    <div class="clip" style:top="{mid + 6}px">{line.clipLabel}</div>
  {/if}
  {#if todayPct !== null}
    <div class="today" style:left="{todayPct}%"></div>
  {/if}
  {#each line.stops as s (s.id)}
    <div class="stop {s.kind}" class:past={s.past} role="img" title={s.tooltip} aria-label={s.tooltip} style:left="{s.pct}%" style:top="{mid}px"></div>
    {#if s.label}<div
      class="label"
      class:mand={s.kind === 'mandatory'}
      class:past={s.past}
      class:muted={s.kind === 'event' || s.kind === 'nudge'}
      style:left="{s.pct}%"
      style:transform={s.pct < 8 ? 'none' : s.pct > 92 ? 'translateX(-100%)' : null}
      style:top={s.labelBelow ? `${mid + 16}px` : `${mid - 44}px`}
    >
      <strong>{s.label}</strong>
      <span>{s.dateLabel}</span>
    </div>{/if}
  {/each}
</div>

<style>
  .track { position: relative; flex: 1; min-width: 0; }
  .seg { position: absolute; height: 6px; border-radius: 3px; }
  .seg.past { background: #c9d1db; }
  .seg.future { background: var(--c); }
  .seg.thin { height: 4px; border-radius: 2px; }
  .seg.us { background: var(--us); }
  .seg.vendor { background: var(--vendor); }
  .seg.customer { background: var(--cust); }
  .ghost { position: absolute; height: 0; border-top: 2px dotted var(--past); }
  .clip { position: absolute; left: 0; font-size: 10px; font-weight: 600; color: var(--muted); white-space: nowrap; }
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
  .stop.event, .stop.event.past { width: 12px; height: 12px; border: 3px solid var(--ink-2); }
  .stop.nudge { width: 14px; height: 14px; border: 2px dashed var(--muted); }
  .label {
    position: absolute; transform: translateX(-50%); white-space: nowrap; text-align: center;
    font-size: 11px; line-height: 1.25; display: flex; flex-direction: column; color: var(--ink);
    /* Sit on a card-colored patch so the TODAY line never runs through the text. */
    z-index: 1; background: var(--card); padding: 0 3px; border-radius: 3px;
  }
  .label strong { letter-spacing: 0.04em; }
  .label.mand { color: var(--red); }
  .label.past { color: #6b7785; }
  .label.muted { color: var(--ink-2); }
</style>
