# Changelog

All notable changes to TrackMyBids.

## v0.8.0 — 2026-11-18 (RFQ Quotes)

Quick RFQs that have no due date now live on the same map as bids.

- **Quotes on the network** — **+ New → Quote** (customer, what they want, when it came in, contact, owner or Unassigned). A quote's line runs from the day it came in up to today, colored by who has the ball: **Us**, a **Vendor**, or the **Customer**. A dotted line shows when the next follow-up is due.
- **Status column** on every row — quotes show who has the ball and for how long, vendor replies (e.g. 2/3) and the next step; bids show the countdown to their next stop and checklist progress. Overdue follow-ups turn red and sort to the top.
- **Vendors** — on a quote (and, collapsed, on any bid): add the vendors you asked, mark replied or skipped, and **Nudge** (copies a follow-up message and restarts the clock). Follow-ups are due 1 business day after asking a vendor and 3 business days after sending the quote.
- **Quote actions** — Mark quote sent, Followed up, Won, Lost, No reply, and **Convert to bid** (asks for a due date; adds the standard checklist).
- **Filters** — All / Bids / Quotes, who has the ball, Overdue only, search (agency, item, vendor), and saved views (My open work, Stuck on vendors, Due this week). All the old filters stay. Closed quotes leave the map 14 days after their last update.
- **Map labels** — stop labels now pick the free side of the line, so close-together stops no longer overlap.
- **Reports** — contacts export gains Kind and Received columns and quote stage names.
- **Pricing grid** — on a quote (and, collapsed as "Add pricing", on any bid): add lines or paste them from Excel (Qty, Description, Part #, and optionally one price column per vendor), enter each vendor's unit prices, and the lowest complete vendor total is picked. **Whole quote** buys everything from one vendor (click another total to switch); **Per line** picks the cheapest vendor per line (or your choice). Markup as %, $ per unit or $ per line, set per quote or per line, or type a sell price and the markup is worked out backward. Round sell prices to the cent, $1 or $5. The summary shows who you're buying from, cost, markup, margin and the quote total; lines with no price are flagged and left out.
- **Default markup** — Settings → Pricing (12% to start). A quote or bid takes it when its first line is added, so everyone on a team sees the same total.
- **Our price** — a bid with priced lines shows its quote total next to the estimate (bid page and hover card). The hover card for a quote lists each vendor's total. Reports value quotes at their quote total (falling back to the estimate) and add an **Our Price** column for bids.
- **Needs you** — a hand icon next to the bell lists what needs you right now: vendors that went quiet (1 business day after asking or your last nudge), quotes with no customer answer (3 business days after sending or your last follow-up), new quotes nobody has claimed (Team mode, 4 work hours), and a bid's mandatory stop within 24 hours. One click to Nudge, Quote without them, Claim / Assign, Followed up, Open bid / Mark done, or Snooze for a day (snoozes stay on your computer). The count turns red when something is overdue. Each new item sends one desktop notification (held during quiet hours, folded into the morning briefing). The thresholds are in Settings → Notifications. On the map, "Overdue only" and the red Status now include unclaimed quotes and mandatory stops within 24 hours.
- **Team servers must be updated first**: apply `supabase/migrations/20261119000000_quotes.sql` before installing this version (sync schema 2). Teammates on older versions see "The team server needs an update" and their sync pauses until they update; nothing is lost. See `docs/TEAM-SETUP.md`.

## v0.7.1 — 2026-11-18

- **Fix: Open at login could stop working.** If TrackMyBids was ever opened straight from Downloads or the .dmg, the login item pointed at a temporary copy that macOS later deletes, so the app didn't start at login (and the morning briefing didn't come). The app now re-points the login item at itself on every launch, and never at a temporary copy. Updating to 0.7.1 and opening it once from Applications fixes it.

## v0.7.0 — 2026-11-18

- **Automatic updates** — TrackMyBids checks for a new version at startup and every few hours. When one is out, a banner offers **Update & restart** (or **Later**); nothing installs until you click. Settings → General also has **Check for updates**. Updates are signed, and the app refuses any that aren't. Coming from v0.6.0 or older? Install v0.7.0 by hand once; after that it updates itself.
- **Remove a team member** (admins) — Settings → Team → Remove. Their bids, including ones in the trash, move to the admin who removed them. Team servers need the new `supabase/migrations/20261118000000_remove_member.sql` applied (see `docs/TEAM-SETUP.md`).

## v0.6.0 — 2026-11-17

Team mode: everyone on the team sees every bid, filtered by owner. Optional — the app works exactly as before when you stay Local.

- **Team mode (optional)** — Settings → Team. Connect to a free Supabase project (setup guide: `docs/TEAM-SETUP.md`).
  - First account on a new server becomes admin. Others sign up with a join code and wait for admin approval.
  - Admins approve, promote or remove members.
  - Works offline: edits queue up and sync when you're back online (every minute, and a few seconds after each edit). When two people edit the same field, the later edit wins.
  - Shared: bids, milestones, checklists, contacts and bid–contact links. Per-person: settings, notifications, checklist template.
  - Leaving the team keeps your local copy.
- **Owner filter** on the map — My bids (default) / Everyone / one person. Owner initials on each line and in the hover card; owner picker on the bid page.
- **Delete guard** — only a bid's owner or an admin can delete it. Deleted bids go to Settings → Team → Trash, where an admin can restore them.
- **Sync status dot** next to Settings (synced, syncing, offline with changes waiting, needs sign-in).
- Reminders and the morning briefing cover only your own bids.
- Contacts → Restore from backup is disabled in Team mode (it would overwrite shared data).
- **Open source** — published under the MIT license at https://github.com/ktraab/track-my-bids (installers are built there from `v*` tags). Decided against live Outlook calendar sync: the team's Outlook calendars are local IMAP calendars with no server to sync with.
- **Closed bids findable again** — new Awarded / Lost / No bid filter chips bring closed bids back onto the map so they can be opened or reopened.

## v0.5.0 — 2026-11-17

Boss requests: day-of-week awareness, hover highlights, and moving off Outlook-calendar bid tracking.

- **Weekdays everywhere** — every date reads like "Thu Nov 26".
- **Holiday-aware shipping** — ship-by dates skip weekends, US federal holidays (observed) and the day after Thanksgiving. Example: a sealed bid due Mon Nov 30, 2026 with a 2-day lead now ships by Tue Nov 24.
- **Day warnings** on the bid page, hover card and morning briefing ("Heads-up"): due on a weekend/holiday, sealed bid due right after a weekend/holiday ("must arrive by Friday"), and holidays inside the shipping window. No warnings for bids already past due.
- **Hover highlights** — rest the pointer on a bid's name for ~0.6 s to see stage, value, next milestone with countdown, ship-by, checklist progress, main contact and warnings. Hovering a stop shows its full date, time and location.
- **Import from Outlook (files)** — Contacts → Import from Outlook…
  - Contacts CSV (matched by email; no-email contacts matched by name + organization).
  - Calendar `.ics` (published calendar link or saved file) and classic Outlook calendar/tasks CSV.
  - Review screen suggests each event's type (due, pre-bid, site walk, Q&A, addenda, award) and mandatory flag, groups events into bids, and matches existing open bids by agency name. Groups without a due date start skipped; a due date can be typed in when the calendar doesn't have one.
  - Handles Windows-1252/UTF-16 exports, Windows time-zone names, recurring meetings (next occurrence only), moved occurrences, and skips cancelled events and completed tasks.
  - Re-importing the same file never duplicates anything.
  - Not included yet: Microsoft To Do tasks (needs a Microsoft 365 connection — planned).
- **Home button** at the top of every screen.
- Fix: typing a due date for an imported group with no checked events now creates the bid (it was silently ignored).

## v0.4.0 — 2026-11-16 (shipped inside v0.5.0; not tagged separately)

- **Settings screen** — briefing times and days, quiet hours, reminder timing per milestone type, ship-by reminders, idle-bid nudge, launch at login, editable checklist template (new bids only), app version and data folder.
- **Network filters** — stage, agency type and submission method chips; remembered between launches.
- **App icon** and a monochrome macOS menu-bar icon.
- **Installers** — tagging `vX.Y.Z` builds an unsigned macOS universal `.dmg` and Windows `.msi`/`-setup.exe` into a draft GitHub release. Install steps: `docs/INSTALL.md`.
- CI runs tests, type checks and a Rust build on every push to `main`.

## v0.3.0 — 2026-11-16

- **Contacts** on every bid (role: procurement, end user, IT, …), shared and de-duplicated by email, plus a Contacts screen.
- **Contacts report** for management — Excel (Contacts + Summary sheets) or CSV, filtered by date range (by due date or date added), stage, agency type, role and value.
- **Add to calendar** — Google Calendar, Outlook (work/school and Outlook.com), or the desktop calendar app (`.ics`); "Add all" includes ship-by.
- **Backup / restore** to a single `.tmb` file (merges; newer edits win; nothing deleted).

## v0.2.0 — 2026-11-16

- **Notifications** — weekday morning briefing (07:30 default), countdown reminders per milestone, sealed-bid ship-by alerts, idle-bid nudges, quiet hours, "While you were away" catch-up, notification inbox with snooze.
- Runs in the menu bar / system tray; closing the window keeps reminders running.

## v0.1.0 — 2026-11-16

- First working app: add bids (⌘/Ctrl+N), "Transit Lines" network view, bid detail with stages, milestones and checklist; local SQLite storage.
