<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { FIELD_NAMES, isLabelField, type ExtractField } from '$lib/domain/extractRules';
  import { checkTagWord, normTagName, scopeTagDefs, tagOwningWord, TAG_FIELD_PREFIX } from '$lib/domain/scopeTags';

  const isTagRow = (field: string) => field.startsWith(TAG_FIELD_PREFIX);
  /** Rows the extractor still reads (older builds also saved label rows for the scope field: hidden, not deleted). */
  const isShown = (field: string) => isLabelField(field) || field === 'scope_heading';

  /** Learned phrases grouped by field, in the order the list arrives (field, then most used). Tag words have their own list. */
  const groups = $derived.by(() => {
    const m = new Map<string, typeof app.extractLabels>();
    for (const l of app.extractLabels) if (isShown(l.field)) (m.get(l.field) ?? m.set(l.field, []).get(l.field)!).push(l);
    return [...m.entries()];
  });
  const fieldName = (f: string) => (f === 'scope_heading' ? 'Scope heading' : FIELD_NAMES[f as ExtractField] ?? f);

  /** Every tag (built-in first) with its team words, each word with the row id to delete it by. */
  const defs = $derived(scopeTagDefs(app.extractLabels));
  const tags = $derived(
    defs.map((d) => ({
      ...d,
      rows: app.extractLabels.filter((l) => isTagRow(l.field) && normTagName(l.field.slice(TAG_FIELD_PREFIX.length)).toLowerCase() === d.tag.toLowerCase()),
    })),
  );
  /** Why a typed tag / word can't be saved (nothing while still empty). */
  const problem = (tag: string, word: string | undefined) => {
    if (!tag.trim() || !word?.trim()) return null;
    const c = checkTagWord(tag, word);
    return 'error' in c ? c.error : null;
  };
  /** "Already a word for Wi-Fi" note while typing a word another tag has. */
  const owner = (tag: string, word: string | undefined) => (word?.trim() && tag.trim() ? tagOwningWord(defs, tag, word) : null);

  let drafts = $state<Record<string, string>>({});
  let newTag = $state('');
  let newWord = $state('');

  async function addWord(tag: string) {
    const word = drafts[tag]?.trim();
    if (word && (await app.addScopeTagWord(tag, word))) drafts[tag] = '';
  }
  async function addTag() {
    if (newTag.trim() && newWord.trim() && (await app.addScopeTagWord(newTag, newWord))) { newTag = ''; newWord = ''; }
  }
</script>

<p class="hint">
  Drop a PDF, Word or Excel RFP on the window (or use <strong>From document…</strong>) to start a new bid from it.
  When you correct a field before saving, TrackMyBids remembers the words in front of the right value and looks for
  them next time{app.team.mode === 'team' ? ' — for your whole team' : ''}. Delete a phrase that leads to wrong guesses.
</p>
{#if groups.length}
  {#each groups as [field, labels] (field)}
    <h3>{fieldName(field)}</h3>
    <ul>
      {#each labels as l (l.id)}
        <li>
          <span>“{l.phrase}” <span class="hint">· used {l.hits} time{l.hits === 1 ? '' : 's'}</span></span>
          <button class="linkish" aria-label="Delete phrase {l.phrase}" onclick={() => app.removeExtractLabel(l.id)}>Delete</button>
        </li>
      {/each}
    </ul>
  {/each}
{:else}
  <p class="hint">No learned phrases yet.</p>
{/if}

<h3>Scope tags</h3>
<p class="hint">
  The Scope field starts with tags for what the document asks for. A tag is used when its words appear twice, or once
  in the scope section or a short document. Add your own words to a tag, or a new tag{app.team.mode === 'team' ? ' (shared with your team)' : ''}.
</p>
<ul>
  {#each tags as t (t.tag)}
    <li class="tag">
      <div class="tagHead">
        <strong>{t.tag}</strong>
        {#if t.words.length}<span class="hint">{t.words.join(', ')}</span>{/if}
      </div>
      {#if t.rows.length}
        <div class="words">
          {#each t.rows as r (r.id)}
            <span class="word">{r.phrase}<button class="x" aria-label="Delete word {r.phrase} from {t.tag}" onclick={() => app.removeExtractLabel(r.id)}>✕</button></span>
          {/each}
        </div>
      {/if}
      <form class="add" onsubmit={(e) => { e.preventDefault(); void addWord(t.tag); }}>
        <input placeholder="Add a word" aria-label="Add a word to {t.tag}" bind:value={drafts[t.tag]} />
        <button class="btn small" disabled={!drafts[t.tag]?.trim() || !!problem(t.tag, drafts[t.tag])}>Add</button>
      </form>
      {#if problem(t.tag, drafts[t.tag])}
        <p class="hint note">{problem(t.tag, drafts[t.tag])}</p>
      {:else if owner(t.tag, drafts[t.tag])}
        <p class="hint note">Already a word for {owner(t.tag, drafts[t.tag])}; added here, it counts for {t.tag} instead.</p>
      {/if}
    </li>
  {/each}
</ul>
<form class="add newTag" onsubmit={(e) => { e.preventDefault(); void addTag(); }}>
  <label class="field"><span>New tag</span><input placeholder="e.g. Furniture" bind:value={newTag} /></label>
  <label class="field"><span>First word</span><input placeholder="e.g. student desk" bind:value={newWord} /></label>
  <button class="btn small" disabled={!newTag.trim() || !newWord.trim() || !!problem(newTag, newWord)}>Add tag</button>
</form>
{#if problem(newTag, newWord)}
  <p class="hint note">{problem(newTag, newWord)}</p>
{:else if owner(newTag, newWord)}
  <p class="hint note">Already a word for {owner(newTag, newWord)}; added here, it counts for {normTagName(newTag)} instead.</p>
{/if}

<style>
  h3 { margin: 8px 0 0; font-size: 15px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; border-top: 1px solid var(--line-soft); }
  li.tag { flex-wrap: wrap; align-items: center; }
  .tagHead { display: flex; gap: 8px; align-items: baseline; min-width: 0; flex: 1 1 260px; }
  .tagHead .hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .words { display: flex; flex-wrap: wrap; gap: 4px; }
  .word { display: inline-flex; align-items: center; gap: 4px; padding: 1px 4px 1px 8px; border: 1px solid var(--line); border-radius: 10px; font-size: 12px; }
  .x { background: none; border: 0; padding: 0 2px; color: var(--muted); cursor: pointer; font-size: 11px; }
  .add { display: flex; gap: 6px; align-items: flex-end; }
  .add input { width: 150px; height: 28px; font-size: 13px; }
  .newTag { margin-top: 8px; gap: 10px; flex-wrap: wrap; }
  .btn.small { height: 28px; padding: 0 10px; font-size: 13px; }
  .note { flex-basis: 100%; margin: 2px 0 0; }
</style>
