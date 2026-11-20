<script lang="ts">
  import { app } from '$lib/state.svelte';
  import type { RowStatus } from '$lib/domain/rowStatus';
  import type { Bid } from '$lib/domain/types';
  import { ballText, type VendorDot, type VendorState } from '$lib/domain/rfq';
  import { initials } from '$lib/domain/ownership';

  let { status, bid, onLog }: { status: RowStatus; bid: Bid; onLog?: (anchor: DOMRect, el: HTMLElement) => void } = $props();

  /** Team mode names who holds an "on us" quote; Local mode has only one "us". */
  const usWho = $derived(app.team.mode === 'team' ? (bid.ownerId ? initials(app.memberName(bid.ownerId)) : 'unassigned') : null);
  const STATE_TEXT: Record<VendorState, string> = { replied: 'replied', skipped: 'skipped', waiting: 'waiting', quiet: 'quiet, nudge due' };
  /** An open quote whose manual next step has come due reads late too (status.overdue is Needs-you only). */
  const rfqNextLate = $derived(
    status.kind === 'rfq' && !!status.ball && !!bid.nextAt && Date.parse(bid.nextAt) <= app.nowMs,
  );
  const dotTitle = (v: VendorDot) => `${v.name}: ${STATE_TEXT[v.state]}`;
</script>

<div class="status">
  {#if status.kind === 'rfq'}
    {#if status.ball}
      <span class="ball {status.ball.holder}" class:late={status.overdue}>
        {ballText(status.ball, app.nowMs, status.ball.holder === 'us' ? usWho : status.ball.who)}
      </span>
    {:else}
      <span class="ball closed">{status.stage}</span>
    {/if}
    <span class="vdots">
      {#if status.vendors.length}
        {#each status.vendors as v (v.id)}<i class={v.state} title={dotTitle(v)}></i>{/each}
        <span>{status.replied}/{status.vendors.length} replied</span>
      {:else}
        <span>No vendors asked</span>
      {/if}
    </span>
    <span class="next" class:late-text={status.overdue || rfqNextLate}>{status.next}</span>
  {:else}
    <span class="cd" class:late-text={status.late || status.overdue}>{status.countdown}</span>
    <span class="vdots"><span>{status.checklistDone}/{status.checklistTotal} checklist</span></span>
    <span class="next" class:late-text={status.touchLate}>{status.touchLine}</span>
    {#if status.vendors.length}
      <span class="vdots">
        {#each status.vendors as v (v.id)}<i class={v.state} title={dotTitle(v)}></i>{/each}
        <span>{status.replied}/{status.vendors.length} vendors</span>
      </span>
    {/if}
  {/if}
  {#if onLog}
    <button class="log" title="Log a call, email, meeting or note" aria-label="Log a touch for {bid.agencyName}"
      onclick={(e) => onLog(e.currentTarget.getBoundingClientRect(), e.currentTarget)}>+</button>
  {/if}
</div>

<style>
  .status {
    width: 232px; flex: none; position: sticky; left: 300px; z-index: 1; background: var(--card);
    /* Right padding keeps status text clear of the Log button. */
    padding: 10px 36px 10px 10px; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 6px;
    border-right: 1px solid var(--line-soft); min-width: 0;
  }
  .next, .cd { font-size: 12px; color: var(--ink-2); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log {
    position: absolute; right: 6px; top: 6px; width: 24px; height: 24px; padding: 0; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--line); background: var(--card); font-size: 16px; font-weight: 600; line-height: 1; color: var(--ink-2); opacity: 0;
  }
  /* Shown while the row is hovered or anything in it has focus. */
  :global(.row:hover) .log, :global(.row:focus-within) .log, .log:focus-visible { opacity: 1; }
  .cd { font-weight: 600; }
</style>
