# Bombuj provider source

This folder contains the exact source snapshot of `CaseyCZ/stremio.bombuj` at Git commit `ad2e496a3ab28b0a7f455dd173b7dad9e8183ef7`, version 0.8.1.

The provider can run independently via `npm install --prefix providers/bombuj`, `npm --prefix providers/bombuj run check` and `npm --prefix providers/bombuj start` (Node.js 20+). **Do not start it on Oracle port 7004 while the original Bombuj PM2 service is still running.** This staged import does not alter any live server, Nginx configuration or secret files.
