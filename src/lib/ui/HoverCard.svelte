<script lang="ts">
  import { app } from '$lib/state.svelte';
  import type { BidWithChildren } from '$lib/domain/types';
  import { effectiveStops } from '$lib/domain/stops';
  import { dayWarnings } from '$lib/domain/dayWarnings';
  import { formatCountdown, formatDateTime } from '$lib/domain/time';
  import { formatMoneyShort } from '$lib/domain/format';
  import { STAGE_LABELS } from '$lib/domain/stages';
  import { METHOD_LABELS } from '$lib/domain/labels';
  import { CONTACT_ROLE_LABELS, contactName } from '$lib/domain/contacts';

  let {
    id,
    data,
    left,
    top = null,
    bottom = null,
    height = $bindable(0),
  }: { id: string; data: BidWithChildren; left: number; top?: number | null; bottom?: number | null; height?: number } = $props();
  const b = $derived(data.bid);
  const next = $derived(effectiveStops(data).find((s) => !s.done && s.ms >= app.nowMs) ?? null);
  const ship = $derived(effectiveStops(data).find((s) => s.derived && s.ms >= app.nowMs) ?? null);
  const warnings = $derived(dayWarnings(data, app.nowMs));
  const done = $derived(data.checklist.filter((c) => c.done).length);
  const contact = $derived(data.contacts.find((c) => c.role === 'procurement') ?? data.contacts[0] ?? null);
</script>

<div
  class="hover-card"
  role="tooltip"
  {id}
  style:top={top !== null ? `${top}px` : null}
  style:bottom={bottom !== null ? `${bottom}px` : null}
  style:left="{left}px"
  bind:clientHeight={height}
>
  <div class="title"><strong>{b.agencyName}</strong> · {b.title}</div>
  <div class="meta">{STAGE_LABELS[b.stage]} · {formatMoneyShort(b.estValue)} · {METHOD_LABELS[b.submissionMethod]}</div>
  {#if app.team.mode === 'team' && b.ownerId}<div class="line"><span class="k">Owner</span>{app.memberName(b.ownerId)}</div>{/if}
  {#if next}
    <div class="line"><span class="k">Next</span>{next.mandatory ? 'MANDATORY ' : ''}{next.title} — {formatDateTime(next.iso, b.timezone)} <em>(in {formatCountdown(app.nowMs, next.ms)})</em></div>
  {/if}
  {#if ship}<div class="line"><span class="k">Ship by</span>{formatDateTime(ship.iso, b.timezone)}</div>{/if}
  <div class="line"><span class="k">Checklist</span>{done}/{data.checklist.length} done</div>
  {#if contact}
    <div class="line"><span class="k">{CONTACT_ROLE_LABELS[contact.role]}</span>{contactName(contact.contact)}{contact.contact.phone ? ` · ${contact.contact.phone}` : ''}{contact.contact.email ? ` · ${contact.contact.email}` : ''}</div>
  {/if}
  {#each warnings as w (w.text)}<div class="warn">⚠ {w.text}</div>{/each}
</div>

<style>
  .hover-card {
    position: fixed; z-index: 40; width: min(420px, calc(100vw - 32px)); padding: 12px 14px; border-radius: 12px;
    background: #fff; border: 1px solid var(--line); box-shadow: 0 16px 40px rgba(22, 32, 44, 0.18);
    display: flex; flex-direction: column; gap: 4px; font-size: 13px; pointer-events: none;
  }
  .title { font-size: 14px; }
  .meta { color: var(--muted); }
  .line { display: flex; gap: 8px; }
  .k { min-width: 84px; color: var(--muted); font-weight: 600; font-size: 12px; }
  em { color: var(--muted); font-style: normal; }
  .warn { margin-top: 4px; padding: 6px 8px; border-radius: 8px; background: #fff7e6; color: #7a4b00; }
</style>
