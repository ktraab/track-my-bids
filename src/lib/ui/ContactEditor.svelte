<script lang="ts" module>
  let nextId = 0;
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { validateContact, type ContactInput } from '$lib/domain/contacts';

  let {
    initial = {},
    submitLabel = 'Save',
    resetOnSubmit = false,
    onSubmit,
    onCancel,
  }: {
    initial?: ContactInput;
    submitLabel?: string;
    resetOnSubmit?: boolean;
    onSubmit: (c: ContactInput) => Promise<boolean>;
    onCancel?: () => void;
  } = $props();

  const blank = () => untrack(() => ({
    firstName: initial.firstName ?? '', lastName: initial.lastName ?? '', title: initial.title ?? '',
    organization: initial.organization ?? '', email: initial.email ?? '', phone: initial.phone ?? '',
  }));
  let f = $state(blank());
  const errId = `cerr-${nextId++}`;
  let errors = $state<string[]>([]);
  let busy = $state(false);
  const emailError = $derived(errors.find((m) => /email/i.test(m)));

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    errors = validateContact(f);
    if (errors.length || busy) return;
    busy = true;
    const ok = await onSubmit({ ...f });
    busy = false;
    if (ok && resetOnSubmit) f = { firstName: '', lastName: '', title: '', organization: '', email: '', phone: '' };
  }
</script>

<form class="contact-form" onsubmit={submit}>
  <div class="grid2">
    <label class="field"><span>First name</span><input bind:value={f.firstName} oninput={() => (errors = [])} autocomplete="off" /></label>
    <label class="field"><span>Last name</span><input bind:value={f.lastName} oninput={() => (errors = [])} autocomplete="off" /></label>
    <label class="field"><span>Title</span><input bind:value={f.title} oninput={() => (errors = [])} placeholder="Purchasing Agent" /></label>
    <label class="field"><span>Organization</span><input bind:value={f.organization} oninput={() => (errors = [])} /></label>
    <label class="field"><span>Email</span><input type="email" bind:value={f.email} oninput={() => (errors = [])} aria-invalid={emailError ? true : undefined} aria-describedby={emailError ? errId : undefined} /></label>
    <label class="field"><span>Phone</span><input type="tel" bind:value={f.phone} oninput={() => (errors = [])} /></label>
  </div>
  {#if errors.length}<p class="err" id={errId} role="alert">{errors[0]}</p>{/if}
  <div class="actions">
    {#if onCancel}<button type="button" class="btn" onclick={onCancel}>Cancel</button>{/if}
    <button type="submit" class="btn primary" disabled={busy}>{submitLabel}</button>
  </div>
</form>

<style>
  .contact-form { display: flex; flex-direction: column; gap: 10px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .err { margin: 0; color: var(--red); font-size: 13px; }
</style>
