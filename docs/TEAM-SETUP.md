# Team setup (admin)

TrackMyBids works on its own (Local mode). Team mode shares bids through a free Supabase project you control.

## 1. Create the server (once)

1. Sign in at https://supabase.com and create a project (free plan). Pick the region closest to your team.
   Free projects pause after 7 days with no use; daily use keeps it awake. A paused project can be resumed from the dashboard.
2. **Authentication → Sign In / Providers → Email:** turn **Confirm email** off. (New accounts still can't see anything until you approve them in the app.)
3. Apply the schema — either:
   - CLI: `supabase link --project-ref <ref>` then `supabase db push` (from this repo), or
   - Dashboard → SQL Editor → paste `supabase/migrations/20261117000000_team_sync.sql` → Run.
4. **Project Settings → API:** copy the **Project URL** and the **publishable** (or legacy **anon**) key. Never use the secret / service_role key in the app.

## 2. Become the admin

1. In TrackMyBids: **Settings → Team → Setting up a new team server?** Paste the Project URL and key → Continue.
2. **Create an account.** The first account on a new server becomes the admin automatically — do this before sharing the join code.
3. Your existing bids upload and are marked as yours.

## 3. Add teammates

1. Settings → Team → **Join code → Copy** and send it to the teammate.
2. They paste it in Settings → Team, create an account, and wait.
3. You approve them in **Members** (choose Member or Admin). They sync right away.

To remove someone, untick **Active**. Their bids stay; reassign them from each bid's Owner menu.

## Notes

- Everyone sees all bids. Anyone can edit; only a bid's owner or an admin can delete, restore or reassign it.
- Deleted bids: admins can restore them from **Settings → Team → Trash**.
- "Restore from backup" is turned off in Team mode (it would overwrite the team's data). Backups still export.
- "The team server needs an update": apply any new files in `supabase/migrations/` (step 1.3).
