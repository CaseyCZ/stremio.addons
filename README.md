# SKTOnline + SKTorrent pro Stremio

Stremio addon z rodiny CaseyCZ apps. Kombinuje přímé streamy z `online.sktorrent.eu` a torrentové zdroje ze `sktorrent.eu`.

## Co umí

- konfigurátor ve stejném stylu jako `stremio.sosac`
- přihlášení na SKTorrent uživatelským jménem a heslem
- automatické získání a obnovení `uid` + `pass` session cookies
- AES-256-GCM šifrovaná instalační konfigurace
- SKTOnline přímé MP4 streamy
- SKTOnline VTT titulky (CZ/SK) přes Stremio `subtitles` resource
- Sosáč katalogová ID (`sosac_m_*`, `sosac_s_*`, `sosac_ep_*`) umí vlastní overlay převést na IMDb/Cinemeta bez změny Sosáč addonu
- SKTorrent `.torrent` metadata převede na `infoHash`, `fileIdx` a trackery pro Stremio
- video ani torrentový datový provoz neproxyuje přes server addonu
- `/health` a `/version` pro dashboard
- PM2 + GitHub Actions deploy

## Lokální spuštění

```bash
npm install
openssl rand -hex 32 > ~/.stremio-sktonline-config-key
chmod 600 ~/.stremio-sktonline-config-key
npm start
```

Výchozí port je `7002`. Otevři `http://localhost:7002/configure`.

## Konfigurace

Volitelné proměnné prostředí:

- `PORT` – HTTP port, výchozí `7002`
- `CONFIG_ENCRYPTION_KEY` – 64 hex znaků
- `CONFIG_ENCRYPTION_KEY_FILE` – soubor s 64hex klíčem

Přihlašovací údaje se nikdy nelogují. Instalační URL obsahuje šifrovanou konfiguraci a je proto stále citlivá.

## Routy

- `/configure`
- `/manifest.json`
- `/:cfg/manifest.json`
- `/:cfg/stream/:type/:id.json`
- `/:cfg/subtitles/:type/:id.json`
- `/health`
- `/version`

## Poznámky

Přihlášení SKTorrentu používá aktuální formulář `torrent/login.php` (`uid` + `pwd`). Při neplatné session se addon znovu přihlásí uloženými údaji bez změny manifest URL.
