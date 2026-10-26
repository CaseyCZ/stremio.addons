# Bombuj: přímé streamy – izolované testování

Rozšíření je součástí **stávajícího doplňku Bombuj**, nikoli samostatný Stremio addon.
Stávající katalogy, přehrávače a značky `🎧` (audio), `💬` (titulky), `🎬` (kvalita)
zůstávají beze změny. Primární pořadí je český dabing, potom anglické audio
se **skutečnou URL českých titulků**, následně deklarované CZ titulky a ostatní.

## Experimentální přímé resolvery

Každý přepínač je záměrně **vypnutý** a dá se aktivovat jednotlivě, výhradně
v izolované testovací instanci. Bez přepínače se používá původní přehrávač.

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
- Byse/Filemoon, VidSrc a další původní přehrávače zachovávají původní
  fallback. Úspěšné načtení stránky (`HTTP 200`) samo o sobě nedokazuje
  dostupnost přímého videa nebo přehratelnost ve Stremio iOS.
- Video ani titulky netečou přes Oracle server; vrací se zdrojová URL.
- Přímá HLS/MP4 URL se kontroluje jen omezenou sondou, nejsou stahována videa.
- Expirované podepsané URL se nemají ukládat do pětiminutové cache.
- Filmy musí odpovídat ověřenému ID/titulu; u seriálů rovněž řadě a dílu.
- Pokud resolver nedostane jednoznačný výsledek, zůstává původní externí
  přehrávač (případné starší filtry nefunkčních iOS embedů se nemění).

## Ověření před zapnutím v provozu

1. `npm run check` v `providers/bombuj` – lokální simulace všech resolverů.
2. Kontrola konkrétního filmu i seriálu v izolovaném Stremio doplňku.
3. Kontrola stejné vydané CDN URL na jiném veřejném IP (zejména Vidara).
4. Ověření českého audia a skutečně načitelných CZ titulků v iOS aplikaci.

Automatizované testy používají simulované odpovědi. Úspěšné testy **neznamenají**
ověřené koncové přehrávání pro každou variantu přehrávače. Případné API rate
limit, změna HTML/tokenů či IP vazba se musí řešit podle reálných výsledků.

Produkční server, výchozí větev ani stávající instalace se nemění automaticky.
