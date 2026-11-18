# TrackMyBids

A free desktop app (macOS and Windows) for sales teams that chase public-sector bids: K-12, higher ed and government. Every open bid is a line on a transit-map timeline, and each deadline is a stop on it: pre-bid meeting, site walk, Q&A, due date, award.

## Features

- **Transit-map timeline** of every open bid, with countdowns, ship-by dates for sealed bids and a "today" marker.
- **Holiday-aware shipping:** ship-by dates skip weekends, US federal holidays and the day after Thanksgiving. The app warns about due dates that fall on or right after one.
- **Checklists** per bid from a template you can edit, plus a stage route: Found → Reviewing → Go/No-Go → Preparing → Submitted → Awarded / Lost / No bid.
- **Reminders and a morning briefing:** desktop notifications per milestone type, quiet hours and nudges about idle bids.
- **Contacts** linked to bids. Imports Outlook contacts (CSV) and calendars (.ics or CSV), turning calendar events into bids and milestones.
- **Filters** by stage, agency type, submission method and owner.
- **Backups and export:** save one backup file and restore it on another computer, or export bids to Excel or CSV.
- **Team mode (optional):** share bids with your team through a free [Supabase](https://supabase.com) project that you own.
  - Everyone sees every bid and filters by owner.
  - Edits work offline and sync when you're back online.
  - An admin approves who joins.
  - No central server, no account with us, no cost.

- **Automatic updates** (from v0.7.0): the app tells you when a new version is out and installs it when you click **Update & restart**. Updates are signed.

Your data stays on your computer unless you turn on Team mode, and then it goes only to your own Supabase project.

## Install

Download the latest installer from [Releases](../../releases), then follow [docs/INSTALL.md](docs/INSTALL.md). The installers aren't code-signed yet, so macOS and Windows show a one-time warning. The install guide explains how to get past it.

## Team mode

One person on the team sets up a free Supabase project in about 15 minutes, using [docs/TEAM-SETUP.md](docs/TEAM-SETUP.md). Everyone else pastes a join code into Settings → Team.

## Development

Built with Tauri 2, Svelte 5, TypeScript and SQLite.

```sh
npm install
npm run tauri dev     # run the app
npx vitest run        # tests
npx svelte-check      # type check
```

The server schema lives in `supabase/migrations/`. Pushing a `vX.Y.Z` tag builds the macOS (universal `.dmg`) and Windows (`.msi` / `.exe`) installers into a draft GitHub release.

## License

[MIT](LICENSE). Free to use, change and share. No warranty.
