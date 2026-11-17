<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { buildDigest, type DigestLine } from '$lib/domain/digest';
  import { isMine } from '$lib/domain/ownership';
  import { tauriNotifier, openNotificationSettings } from '$lib/notify/notifier';

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let dialog: HTMLDialogElement | undefined = $state();
  let sentTest = $state(false);
  const dg = $derived(buildDigest(app.bids.filter((d) => isMine(d.bid, app.meId)), app.nowMs, zone, app.notificationSettings));
  const sections = $derived<[string, DigestLine[], boolean][]>([
    ['Overdue', dg.overdue, true],
    ['Today', dg.today, false],
    ['Ship within 3 days', dg.shipBy, true],
    ['Next 7 days', dg.week, false],
    ['Idle bids', dg.stale, false],
    ['Heads-up', dg.headsUp, false],
  ]);

  $effect(() => {
    dialog?.showModal();
  });

  function openBid(id: string) {
    app.open(id);
    dialog?.close();
  }

  async function openSettings() {
    try {
      await openNotificationSettings();
    } catch (e) {
      app.error = `Couldn't open settings: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // macOS won't pop a banner for the app that's in front, so give the user time to switch away.
  const TEST_DELAY_S = 5;
  let countdown = $state(0);

  function sendTest() {
    if (countdown > 0) return;
    sentTest = false;
    countdown = TEST_DELAY_S;
    const timer = setInterval(async () => {
      countdown -= 1;
      if (countdown > 0) return;
      clearInterval(timer);
      try {
        await tauriNotifier.send(dg.title, dg.body);
        sentTest = true;
      } catch (e) {
        app.error = `Couldn't send notification: ${e instanceof Error ? e.message : String(e)}`;
      }
    }, 1000);
  }
</script>

<dialog bind:this={dialog} onclose={() => (app.panel = null)} aria-labelledby="digest-title">
  <div class="wrap">
    <header>
      <div>
        <div class="eyebrow">Today's briefing</div>
        <h2 id="digest-title">{dg.subtitle}</h2>
      </div>
      <button class="icon" aria-label="Close" onclick={() => dialog?.close()}>✕</button>
    </header>
    {#if dg.empty && !dg.headsUp.length}
      <p class="calm">No deadlines in the next 7 days.</p>
    {/if}
    {#each sections as [label, lines, urgent] (label)}
      {#if lines.length}
        <section>
          <h3 class:urgent class:heads={label === 'Heads-up'}>{label}</h3>
          <ul>
            {#each lines as l, i (l.bidId + l.text + i)}
              <li><button class="linkline" class:mand={l.mandatory} onclick={() => openBid(l.bidId)}>{l.text}</button></li>
            {/each}
            {#if label === 'Next 7 days' && dg.weekMore > 0}<li class="hint">+{dg.weekMore} more</li>{/if}
          </ul>
        </section>
      {/if}
    {/each}
    <footer>
      <span class="hint">Arrives automatically at {app.notificationSettings.digestTimes.join(', ') || '—'} on weekdays.</span>
      <button class="btn" onclick={sendTest} disabled={countdown > 0}>
        {#if countdown > 0}Sending in {countdown}s, switch to another app…{:else if sentTest}Sent ✓ (send again){:else}Send test notification{/if}
      </button>
    </footer>
    <p class="hint help">
      Didn't see it?
      <button class="linkbtn" onclick={openSettings}>Open notification settings</button>
    </p>
  </div>
</dialog>

<style>
  dialog { border: 0; border-radius: 16px; padding: 0; width: min(620px, calc(100vw - 32px)); box-shadow: 0 24px 60px rgba(22, 32, 44, 0.25); }
  dialog::backdrop { background: rgba(22, 32, 44, 0.35); }
  .wrap { padding: 20px 24px; display: flex; flex-direction: column; gap: 14px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; }
  h2 { font-size: 24px; }
  h3 { margin: 0 0 6px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
  h3.heads { color: #b45f00; }
  h3.urgent { color: var(--red); }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .linkline { background: none; border: 0; padding: 6px 0; text-align: left; width: 100%; }
  .linkline:hover { text-decoration: underline; }
  .linkline.mand { font-weight: 600; }
  .calm { margin: 0; color: var(--ink-2); }
  footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--line-soft); padding-top: 12px; }
  .help { margin: -6px 0 0; }
  .linkbtn { background: none; border: 0; padding: 0; color: var(--ink-2); text-decoration: underline; font: inherit; cursor: pointer; }
</style>
