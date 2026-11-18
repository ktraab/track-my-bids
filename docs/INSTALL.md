# Installing TrackMyBids

## Mac
1. Download `TrackMyBids_<version>_universal.dmg` from the latest release.
2. Open it and drag **TrackMyBids** into **Applications**.
3. Open TrackMyBids from Applications.
4. If macOS says it can't verify the developer (the app isn't signed with an Apple developer certificate yet), click **Done**, then open **System Settings → Privacy & Security**, scroll down, click **Open Anyway** next to the TrackMyBids message, and confirm with **Open Anyway** (enter your password if asked). You only need to do this once. On macOS 14 and older, right-click the app → **Open** → **Open** also works.
5. Allow notifications when asked. In System Settings → Notifications → TrackMyBids, set the style to **Persistent** so reminders stay on screen.

## Windows
1. Download `TrackMyBids_<version>_x64_en-US.msi` (or the `-setup.exe`).
2. Run it. If Windows SmartScreen appears: **More info → Run anyway**.
3. TrackMyBids lives in the system tray (bottom right). Closing the window keeps reminders running.

## Updates
TrackMyBids updates itself from v0.7.0 on. When a new version is out, a banner asks **Update & restart**; click it and the app reinstalls and reopens (no Open Anyway or SmartScreen step this time). Settings → General → **Check for updates** checks right away. Versions before v0.7.0 can't update themselves: download v0.7.0 once and install it over the old one.

## Your data
Everything is stored on your computer. Use **Contacts → Back up all data** to save a backup file, and **Restore from backup** on a new computer.

## Sharing bids with a team (optional)
TrackMyBids can sync bids between teammates through a free Supabase project that you own. See [TEAM-SETUP.md](TEAM-SETUP.md). If you skip this, nothing ever leaves your computer.
