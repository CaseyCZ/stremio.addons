# Bombuj v CaseyCZ/stremio.addons

Tento modul obsahuje původní funkční zdrojové kódy Bombuj 0.8.1, importované z dnes již smazaného repozitáře `CaseyCZ/stremio.bombuj` (historický commit `ad2e496a3ab28b0a7f455dd173b7dad9e8183ef7`).

**Nasazení:** Bombuj nyní běží ze společného repozitáře `CaseyCZ/stremio.addons`. PM2 proces `stremio-bombuj` používá na Oracle soubor `/home/ubuntu/stremio.addons/providers/bombuj/preflight-front.js` a veřejnou cestu `/stremio-bombuj/`. Pracovní adresář na Oracle odpovídá názvu společného repozitáře: `stremio.addons`.

Původní kopie Bombuj je archivovaná v `/home/ubuntu/archiv/stremio.bombuj-2026-10-19`. Žádný běžný deploy z ní nesmí aktualizovat produkční službu.

**Testování:** `npm install --prefix providers/bombuj` a `npm --prefix providers/bombuj run check` (Node 20+). Nikdy nespouštějte současně dvě produkční instance na portu 7004.
