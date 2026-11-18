# Publishing the public repo

This private repo (`ktraab/trackmybids`) is the source of truth. The public, MIT-licensed copy lives at **https://github.com/ktraab/track-my-bids** and is refreshed by hand from a snapshot of `main`.

## What the public copy leaves out

- `docs/superpowers/`: internal design specs and plans. They mention the live Supabase project and internal requests.
- This repo's README. The public repo has its own user-facing README; keep it in step when features change.

Nothing secret is stored in the code. The app only ever uses a Supabase *publishable* key, which users paste into Settings → Team. Never commit a secret or `service_role` key.

## Refreshing it

1. In a scratch folder, export `main` and drop the internal docs:
   ```sh
   git archive main | tar -x -C <scratch>
   rm -rf <scratch>/docs/superpowers
   ```
2. Copy the public README over the exported one. Change the CHANGELOG intro to "All notable changes to TrackMyBids." (the private version points to internal docs).
3. Check for anything private before pushing: `grep -rnE "dxpkzj|sb_secret|service_role|@gmail"`.
4. In a clone of `track-my-bids`, replace the files with the snapshot, then commit as `TrackMyBids <trackmybids@users.noreply.github.com>` and push `main`.

## Releases

Push a `vX.Y.Z` tag **to the public repo**. Bump `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `Cargo.lock` together first. The Release workflow then builds an unsigned macOS universal `.dmg` and Windows `.msi`/`-setup.exe` into a **draft** release; check it, then publish.

### Update signing key

Installed apps (v0.7.0+) find updates at `releases/latest/download/latest.json` on the public repo, so only **published** releases reach them: a draft is invisible until you publish it. Each update bundle is signed; the matching public key is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) and the app rejects anything else.

- Private key: `~/.tauri/trackmybids.key` on the maintainer's Mac. Its password is in the macOS Keychain, service "TrackMyBids updater key password".
- Both are GitHub Actions secrets on the public repo: `TAURI_SIGNING_PRIVATE_KEY` (file contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Back the key up somewhere safe.** If it's lost, installed apps can never auto-update again; everyone would have to reinstall a build with a new public key by hand.

Releases are built in the public repo because GitHub Actions minutes are free for public repos, while macOS minutes on private repos count 10× against the free allowance.
