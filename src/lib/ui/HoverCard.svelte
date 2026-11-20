<script lang="ts">
  import { app } from '$lib/state.svelte';
  import type { BidWithChildren } from '$lib/domain/types';
  import { effectiveStops } from '$lib/domain/stops';
  import { dayWarnings } from '$lib/domain/dayWarnings';
  import { formatCountdown, formatDateTime } from '$lib/domain/time';
  import { formatMoney, formatMoneyShort } from '$lib/domain/format';
  import { pricingOf } from '$lib/domain/pricing';
  import { STAGE_LABELS, stageLabel } from '$lib/domain/stages';
  import { METHOD_LABELS } from '$lib/domain/labels';
  import { CONTACT_ROLE_LABELS, contactName } from '$lib/domain/contacts';
  import { initials } from '$lib/domain/ownership';
  import { erateSummary } from '$lib/domain/erate';
  import { ballOf, ballText, liveVendors, nextStepText, receivedIso, vendorStatusText } from '$lib/domain/rfq';

  let {
    id,
    data,
    left,
    top = null,
    bottom = null,
    height = $bindable(0),
  }: { id: string; data: BidWithChildren; left: number; top?: number | null; bottom?: number | null; height?: number } = $props();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const b = $derived(data.bid);
  const isQuote = $derived(b.kind === 'rfq');
  const next = $derived(effectiveStops(data).find((s) => !s.done && s.ms >= app.nowMs) ?? null);
  const ship = $derived(effectiveStops(data).find((s) => s.derived && s.ms >= app.nowMs) ?? null);
  const warnings = $derived(dayWarnings(data, app.nowMs));
  const done = $derived(data.checklist.filter((c) => c.done).length);
  const contact = $derived(data.contacts.find((c) => c.role === 'procurement') ?? data.contacts[0] ?? null);
  const ball = $derived(isQuote ? ballOf(b, data.vendorQuotes) : null);
  // Same "who" as StatusCell: owner initials (or "unassigned") when the ball is on us in Team mode.
  const usWho = $derived(app.team.mode === 'team' ? (b.ownerId ? initials(app.memberName(b.ownerId)) : 'unassigned') : null);
  const vendors = $derived(liveVendors(data.vendorQuotes));
  const pricing = $derived(data.lines.length ? pricingOf(data, app.pricingDefaults) : null);
  const ourPrice = $derived(pricing && pricing.summary.priced ? pricing.summary.total : null);
  const unpricedText = $derived(pricing && pricing.summary.flagged > 0 ? ` partial · ${pricing.summary.flagged} unpriced` : '');
  /** A vendor's total ("$19,550.00"), or its partial total with coverage ("$4,210.00 · 3 of 5"). */
  function vendorPrice(id: string): string {
    const t = pricing?.totals.find((x) => x.vendorId === id);
    if (!t || !pricing || t.total === null) return '';
    return t.complete ? formatMoney(t.total) : `${formatMoney(t.total)} · ${t.priced} of ${pricing.lines.length}`;
  }
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
  {#if isQuote}
    <div class="meta">Quote · {stageLabel('rfq', b.stage)} · received {formatDateTime(receivedIso(b), zone)}</div>
  {:else}
    <div class="meta">{STAGE_LABELS[b.stage]} · {formatMoneyShort(b.estValue)} · {METHOD_LABELS[b.submissionMethod]}</div>
  {/if}
  {#if b.erate}<div class="line"><span class="k">E-Rate</span>{erateSummary(b)}</div>{/if}
  {#if app.team.mode === 'team'}<div class="line"><span class="k">Owner</span>{b.ownerId ? app.memberName(b.ownerId) : 'Unassigned'}</div>{/if}
  {#if isQuote}
    {#if ball}<div class="line"><span class="k">Ball</span>{ballText(ball, app.nowMs, ball.holder === 'us' ? usWho : ball.who)}</div>{/if}
    <div class="line"><span class="k">Next</span>{nextStepText(data, app.nowMs, zone, app.followUp)}</div>
    {#if ourPrice !== null}<div class="line"><span class="k">Quote total</span>{formatMoney(ourPrice)}{unpricedText}</div>{/if}
    {#each vendors as v (v.id)}
      {@const price = vendorPrice(v.id)}
      <div class="line"><span class="k">{v.vendorName}</span>{vendorStatusText(v, app.nowMs, zone, app.followUp)}{#if price} · {price}{/if}</div>
    {:else}
      <div class="line"><span class="k">Vendors</span>None asked yet</div>
    {/each}
  {:else}
    {#if next}
      <div class="line"><span class="k">Next</span>{next.mandatory ? 'MANDATORY ' : ''}{next.title} — {formatDateTime(next.iso, b.timezone)} <em>(in {formatCountdown(app.nowMs, next.ms)})</em></div>
    {/if}
    {#if ship}<div class="line"><span class="k">Ship by</span>{formatDateTime(ship.iso, b.timezone)}</div>{/if}
    <div class="line"><span class="k">Checklist</span>{done}/{data.checklist.length} done</div>
    {#if ourPrice !== null}<div class="line"><span class="k">Our price</span>{formatMoney(ourPrice)}{unpricedText} <em>(est. {formatMoneyShort(b.estValue)})</em></div>{/if}
    {#if vendors.length}
      <div class="line"><span class="k">Vendors</span>{vendors.filter((v) => v.repliedAt).length}/{vendors.length} replied</div>
    {/if}
  {/if}
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
  .k { min-width: 84px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-weight: 600; font-size: 12px; }
  em { color: var(--muted); font-style: normal; }
  .warn { margin-top: 4px; padding: 6px 8px; border-radius: 8px; background: #fff7e6; color: #7a4b00; }
</style>
