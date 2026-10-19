<p align="center">
  <img src="readme-header.svg" alt="CaseyCZ Stremio Addons: SKTOnline, SKTorrent, Bombuj a Přehraj.to" width="100%" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/CZ-%C4%8Ce%C5%A1tina-38BDF8?style=for-the-badge&labelColor=0284C7" alt="Čeština" />
</p>

<p align="center">
  Neoficiální komunitní sada doplňků pro <strong>Stremio</strong>: <strong>SKTOnline Direct</strong>, <strong>SKTorrent P2P</strong>, <strong>Bombuj</strong> a <strong>Přehraj.to Direct</strong>.
</p>

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/CaseyCZ/stremio.addons?style=for-the-badge&label=VERZE&color=38BDF8&labelColor=0284C7" alt="Aktuální verze CaseyCZ Stremio Addons" />
</p>

<p align="center">
  <a href="https://130.61.49.108/stremio-sktonline/configure"><img src="https://img.shields.io/badge/Otev%C5%99%C3%ADt-Spole%C4%8Dnou%20konfiguraci-198CC8?style=for-the-badge&labelColor=14263B" alt="Otevřít konfiguraci všech tří doplňků" /></a>
  <a href="https://130.61.49.108/stremio-bombuj/manifest.json"><img src="https://img.shields.io/badge/Bombuj-P%C5%99%C3%ADm%C3%A1%20instalace-AD6CAF?style=for-the-badge&labelColor=14263B" alt="Bombuj – přímá instalace bez přihlášení" /></a>
</p>

## O projektu

**CaseyCZ Stremio Addons** nabízí na jedné konfigurační stránce čtyři odděleně instalovatelné doplňky. Každý má vlastní manifest a funguje samostatně.

| Doplněk | Zdroje | Přihlášení |
| --- | --- | --- |
| 🎬 **SKTOnline Direct** | Přímé streamy a dostupné titulky | Nepotřebuje |
| 🧲 **SKTorrent P2P** | Torrentové zdroje se seedery a kvalitou | Vlastní účet SKTorrent |
| 🍿 **Bombuj** | Filmy, seriály, přehrávače a Cinemeta | Nepotřebuje |
| ▶ **Přehraj.to Direct** | Přímá MP4 CDN videa a titulky dle dostupnosti | Nepotřebuje |

## Hlavní funkce

- 🎬 přímé video zdroje SKTOnline
- 🧲 samostatně instalovatelné P2P torrenty SKTorrent
- 🍿 samostatný Bombuj s filmovými a seriálovými katalogy
- ▶ samostatné Přehraj.to přes česká vyhledávací a resolver API
- 💬 dostupné titulky a rozpoznaný jazyk přehrávání
- 🔗 kompatibilita titulů přes IMDb/Cinemeta i vlastní ID Bombuj
- ⚡ rychlejší opakované vyhledávání díky dočasné cache
- 📱 podpora běžných Stremio klientů podle možností jejich přehrávačů

## Společný repozitář

Všechny čtyři doplňky i konfigurátor jsou spravovány v [CaseyCZ/stremio.addons](https://github.com/CaseyCZ/stremio.addons). Bombuj se spouští z `providers/bombuj/`. Pracovní adresář na Oracle je `/home/ubuntu/stremio.addons`. Veřejné instalační cesty `/stremio-sktonline/` a `/stremio-bombuj/` zůstávají kvůli kompatibilitě nezměněné.

## Instalace doplňků

**Společná konfigurace** slouží k instalaci všech tří doplňků:

1. **SKTOnline Direct** – vybereš instalaci bez přihlášení.
2. **SKTorrent P2P** – zadáš svůj SKTorrent účet a po ověření získáš šifrovaný instalační odkaz.
3. **Bombuj** – nainstaluješ bez přihlášení; případně můžeš zapnout volitelné propojení se Sosáčem.
4. **Přehraj.to Direct** – nainstaluješ bez přihlášení. Manifest má samostatnou cestu `/stremio-sktonline/prehrajto/manifest.json`.

Samostatné tlačítko **Bombuj – Přímá instalace** nad tímto textem vede rovnou na jeho veřejný manifest. Doplňky můžeš instalovat nezávisle v libovolné kombinaci.

## Volitelné propojení se Sosáčem

Můžeš zadat své údaje Sosáč pro rozpoznání položek z jeho katalogu. Každý doplněk pak nabídne své vlastní dostupné streamy také u podporovaných titulů Sosáč.

**Samotný Sosáč ani jeho repozitář neupravujeme.** Bez přihlašovacích údajů k Sosáči všechny tři doplňky nadále fungují se svými podporovanými tituly.

Bombuj používá při volitelném propojení šifrovaný instalační manifest; bez propojení zůstává na svém samostatném serverovém procesu.

## Přehraj.to Direct – technické poznámky

Nový nezávislý zdroj funguje pouze pro IMDb/Cinemeta ID (`tt...` a u seriálů `tt...:sezóna:epizoda`). Před resolvem kontroluje úplný název, rok u filmů a přesnou epizodu u seriálů. Vyhledává přes externí službu Blaniok a obnovuje podepsanou MP4 URL přes `ceskarepublika.wiki/api/movies/video-url`. Obě služby jsou třetí strany; nemají garantovanou dostupnost ani veřejné SLA.

MP4 i VTT se předávají jako přímé adresy CDN, **neprocházejí přes Oracle**. Titulky se připojují přímo ke konkrétnímu streamu. Jazyky `cze/slo/eng/ng1/ng2` se převádějí na ISO 639-2 `ces/slk/eng`. Není-li kvalita explicitně ověřená API, stream se **neoznačuje 1080p jen podle názvu souboru**. Externí služba může vrátit jen jednu MP4, ačkoli název uploadu naznačuje vyšší kvalitu.

Přehraj.to není zahrnuto do stávajících šifrovaných konfigurací SKTOnline, SKTorrent či Bombuj. Jeho instalace nemění žádné již nainstalované doplňky.

## Soukromí a přehrávání

Údaje k SKTorrentu a volitelně k Sosáči se ukládají do šifrované instalační konfigurace. **Instalační odkazy obsahující konfiguraci nesdílej veřejně.**

Videa z SKTOnline a Bombuj neprocházejí serverem doplňků. Torrenty jsou samostatné P2P zdroje. Některé webové přehrávače Bombuj nemusí být kompatibilní se všemi Stremio klienty.

## Důležité

Projekt je neoficiální komunitní doplněk a není oficiálně spojen se službami Stremio, SKTOnline, SKTorrent, Bombuj ani Sosáč. Dostupnost zdrojů závisí na původních poskytovatelích.

## Podpora

<p align="center">
  <a href="https://www.buymeacoffee.com/caseycz"><img src="https://img.shields.io/badge/Podpo%C5%99it%20CaseyCZ-Buy%20Me%20a%20Coffee-38BDF8?style=for-the-badge&labelColor=0284C7&logo=buymeacoffee&logoColor=white" alt="Podpořit CaseyCZ" /></a>
</p>

<p align="center">
  <a href="https://www.buymeacoffee.com/caseycz"><img src="https://caseycz.github.io/support-qr.svg" width="150" alt="QR kód Buy Me a Coffee CaseyCZ" /></a><br>
  <sub>Naskenuj QR kód nebo klikni na tlačítko.</sub>
</p>

<p align="center">
  <a href="https://caseycz.github.io/"><img src="https://img.shields.io/badge/CaseyCZ%20Website-Otev%C5%99%C3%ADt-172033?style=flat-square&labelColor=111827" alt="CaseyCZ Website" /></a>
</p>
