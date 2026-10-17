# SKTOnline + SKTorrent pro Stremio

Stremio addon z rodiny CaseyCZ apps. Kombinuje **přímé SKTOnline streamy**, **SKTOnline titulky** a volitelné **SKTorrent P2P** zdroje. Součástí je také vlastní **Sosáč ID overlay**, který převádí položky katalogu Sosáče na IMDb/Cinemeta bez jakékoliv změny Sosáč addonu.

## Co addon umí

- vyhledává přímé SKTOnline MP4 streamy
- zobrazuje kvalitu a dostupné jazykové informace zdroje
- zachovává oddělené varianty podle audia a titulků
- poskytuje dostupné SKTOnline VTT titulky přes Stremio `subtitles` resource
- hledá SKTOnline přehrávače také z detailů na `sktorrent.eu`
- volitelně přidává SKTorrent P2P zdroje
- u torrentů zobrazuje původní název releasu, jazykové informace, kvalitu, seedery a velikost
- `.torrent` metadata převádí na `infoHash`, `fileIdx` a trackery pro Stremio
- automaticky obnovuje přihlášení na SKTorrent při vypršení session
- převádí `sosac_m_*`, `sosac_s_*` a `sosac_ep_*` na IMDb/Cinemeta ve vlastní overlay vrstvě
- ukládá instalační konfiguraci šifrovaně pomocí AES-256-GCM
- poskytuje `/health` a `/version` pro dashboard a kontrolu nasazení

## Direct vs. P2P

**SKTOnline Direct** a **SKTorrent P2P** jsou oddělené zdroje.

U Direct streamu server addonu pouze najde správný SKTOnline zdroj. Výsledná MP4 URL je předána přímo Stremiu a video se přehrává z CDN SKTorrentu — datový tok videa nejde přes server addonu.

U P2P zdroje server po přihlášení získá `.torrent`, vybere odpovídající video soubor a Stremiu předá torrentová metadata. Samotné přehrávání pak probíhá mezi Stremiem a peery.

## Cloudflare WARP

Server může pro požadavky na `online.sktorrent.eu` používat lokální Cloudflare WARP SOCKS proxy. Důvodem je dostupnost SKTOnline z hostingové sítě.

WARP slouží pouze pro **serverové vyhledání SKTOnline stránky, metadata, kontroly CDN a titulky**. Finální MP4 stream se přes WARP ani přes server addonu neproxyuje.

Příklad:

```bash
SKTONLINE_PROXY_URL=socks5h://127.0.0.1:40000
```

## Konfigurace

Konfigurátor umožňuje:

- zvolit jazyk addonu
- zapnout nebo vypnout SKTorrent P2P
- zadat SKTorrent uživatelské jméno a heslo
- volitelně zadat údaje k Sosáči pro vlastní `sosac_* → IMDb/Cinemeta` overlay
- hesla lze v konfigurátoru dočasně zobrazit nebo znovu skrýt

Přihlašovací údaje se nelogují. Instalační token je šifrovaný pomocí AES-256-GCM. Instalační URL je přesto vhodné považovat za citlivou.

## Přihlášení SKTorrent

Přihlášení používá aktuální formulář `torrent/login.php` (`uid` + `pwd`). Addon udržuje session cookies a při jejich vypršení se automaticky znovu přihlásí uloženými údaji. Uživatel proto nemusí addon přeinstalovávat.

## Sosáč overlay

Repo ani addon Sosáče se neupravuje. SKTOnline addon má vlastní překladovou vrstvu, která podle údajů ze Sosáče dohledá odpovídající IMDb/Cinemeta ID a následně hledá vlastní SKTOnline a SKTorrent zdroje.

## Lokální spuštění

```bash
npm install
openssl rand -hex 32 > ~/.stremio-sktonline-config-key
chmod 600 ~/.stremio-sktonline-config-key
npm start
```

Výchozí port je `7002`. Konfigurátor je na:

```text
http://localhost:7002/configure
```

## Proměnné prostředí

- `PORT` – HTTP port, výchozí `7002`
- `CONFIG_ENCRYPTION_KEY` – 64 hex znaků
- `CONFIG_ENCRYPTION_KEY_FILE` – soubor s 64hex klíčem
- `SKTONLINE_PROXY_URL` – volitelná SOCKS proxy pro serverové SKTOnline požadavky, např. `socks5h://127.0.0.1:40000`

## Routy

- `/configure`
- `/manifest.json`
- `/:cfg/manifest.json`
- `/:cfg/stream/:type/:id.json`
- `/:cfg/subtitles/:type/:id.json`
- `/health`
- `/version`

## Nasazení

Projekt používá PM2 a GitHub Actions validaci. Před nasazením se kontroluje syntaxe hlavních Node.js souborů, vazba verze a deploy skript.
