# Bombuj: přímé streamy – izolované testování

Rozšíření je součástí **stávajícího doplňku Bombuj**, nikoli samostatný Stremio addon.
Stávající katalogy, objevování všech původních přehrávačů a značky `🎧` (audio),
`💬` (titulky), `🎬` (kvalita) zůstávají zachované. **Stremio však dostane jen
přímé HLS/MP4 streamy v poli `url`, nikoliv stránky v `externalUrl`.**
Primární pořadí je český dabing, potom anglické audio
se **skutečnou URL českých titulků**, následně deklarované CZ titulky a ostatní.

## Experimentální přímé resolvery

Přepínače lze ovládat jednotlivě. **Na osobní produkční instanci jsou všechny
níže uvedené přímé resolvery zapnuté**, včetně `BOMBUJ_DIRECT_VOE=1`.
Při vypnutí resolveru se původní adresa stále rozpoznává a může být uvedena
v soukromém diagnostickém logu, ale webový přehrávač se nepřidá mezi streamy.

| Přepínač (`=1`) | Zdroj v Bombuj | Přímé video, pokud existuje |
| --- | --- | --- |
| `BOMBUJ_DIRECT_VIDARA` | Vidara embed | HLS ze signovaného CDN |
| `BOMBUJ_DIRECT_PLOYAN` | Primewire | Přes přesnou shodu název+rok / seriál+řada: Ployan HLS, případně Vidara; všechny platné VTT titulky |
| `BOMBUJ_DIRECT_VIDAPI` | VidAPI | Přímo od VidAPI, zatím pouze filmy s ověřeným IMDb ID |
| `BOMBUJ_DIRECT_VIDNEST` | VidNest | TMDb ID z původního Bombuj přehrávače → VidNest HLS |
| `BOMBUJ_DIRECT_VIDLINK` | VidLink | Přes příslušný backend VidNest (best effort) |
| `BOMBUJ_DIRECT_VIDEASY` | Videasy | Přes příslušný backend VidNest (best effort) |
| `BOMBUJ_DIRECT_STREAMTAPE` | Streamtape | Statické složení tokenu → originální MP4 CDN, pokud projde krátká range sonda |

- VOE a Mixdrop mají vlastní existující přímé resolvery; nic se v nich nemaže.
- Byse/Filemoon, VidSrc a další původní přehrávače se dále vyhledávají a
  zaznamenávají; pokud z nich zatím nelze získat přímé HLS/MP4, jejich
  webová adresa se do výsledku Stremia nepřidává. Úspěšné načtení stránky (`HTTP 200`) samo o sobě nedokazuje
  dostupnost přímého videa nebo přehratelnost ve Stremio iOS.
- Video ani titulky netečou přes Oracle server; vrací se zdrojová URL.
- Přímá HLS/MP4 URL se kontroluje jen omezenou sondou, nejsou stahována videa.
- Expirované podepsané URL se nemají ukládat do pětiminutové cache.
- Filmy musí odpovídat ověřenému ID/titulu; u seriálů rovněž řadě a dílu.
- Pokud resolver nenajde přímé video, daný zdroj se pro tento požadavek
  nezobrazí ve Stremiu; důvod a původní URL zůstávají v diagnostice.
  `BOMBUJ_SHOW_ALL_SOURCES=1` nesmí toto pravidlo změnit. Přímé URL je
  kandidát k přehrání, ne záruka přehratelnosti na každém zařízení.

## Diagnostika v soukromém Dashboardu

V **Dashboard → Log Manager → stremio-addons-bombuj → výstup** vyhledej
`[BOMBUJ RESOLVER]`. Každý záznam obsahuje čas a `requestId`, podle kterého
lze spojit jednotlivé pokusy stejného požadavku.

- `playerUrl`: původní adresa přehrávače objevená na Bombuj.
- `requestUrl`: **přesná adresa volaná resolverem**, například API VidNest
  nebo stránka Mixdrop. Při chybě `http-403` je vidět i tato konkrétní URL.
- `mediaUrl`: přímá HLS/MP4 adresa nalezená při rozboru stránky.
- `handedToStremio`: **přesná přímá video adresa předaná Stremiu**. Vyskytuje
  se pouze u `result=direct`; při `result=no-direct-media` je zdroj vynechán.
- `reason` a `stage`: kde pokus skončil a proč (HTTP, token, HLS apod.).

Přesné adresy se zapisují pouze při `BOMBUJ_RESOLVER_LOG_URLS=1`.
Zpravidla obsahují krátkodobé CDN podpisy či tokeny, proto soukromý log
nikam veřejně nekopírovat. PM2 logrotate omezuje dobu uchování.

## Ověření před zapnutím v provozu

1. `npm run check` v `providers/bombuj` – lokální simulace všech resolverů.
2. Kontrola konkrétního filmu i seriálu v izolovaném Stremio doplňku.
3. Kontrola stejné vydané CDN URL na jiném veřejném IP (zejména Vidara).
4. Ověření českého audia a skutečně načitelných CZ titulků v iOS aplikaci.

Automatizované testy používají simulované odpovědi. Úspěšné testy **neznamenají**
ověřené koncové přehrávání pro každou variantu přehrávače. Případné API rate
limit, změna HTML/tokenů či IP vazba se musí řešit podle reálných výsledků.

Nasazení osobní produkce probíhá přes existující GitHub Actions a Oracle PM2.
