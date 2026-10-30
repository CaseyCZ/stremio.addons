<p align="center">
  <img src="readme-header.svg" alt="CaseyCZ Stremio Addons – SKTOnline, SKTorrent, Bombuj a Přehraj.to" width="100%" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/CZ-%C4%8Ce%C5%A1tina-38BDF8?style=for-the-badge&labelColor=0284C7" alt="Čeština" />
</p>

<p align="center">
  Komunitní doplňky pro <strong>Stremio</strong> na jednom místě.<br>
  Vyber si zdroje filmů a seriálů, které chceš používat.
</p>

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/CaseyCZ/stremio.addons?style=for-the-badge&label=VERZE&color=38BDF8&labelColor=0284C7" alt="Aktuální verze" />
</p>

<p align="center">
  <a href="https://130.61.49.108/stremio-addons/configure"><img src="https://img.shields.io/badge/Konfigurace-Otev%C5%99%C3%ADt-38BDF8?style=for-the-badge&labelColor=0284C7&logo=googlechrome&logoColor=white" alt="Otevřít konfiguraci doplňků" /></a>
</p>

## O projektu

**CaseyCZ Stremio Addons** přidává do Stremia další možnosti, kde hledat a přehrávat filmy a seriály. Doplňky jsou **samostatné** – můžeš si nainstalovat jeden, několik nebo všechny.

> **Pouze větev `feature/search-improvements`:** HellSpy Direct TEST a Sledujteto Direct TEST jsou experimentální zdroje. Nejsou nasazené na produkčním serveru. HellSpy vyhledávání z Oracle bylo omezeno HTTP 429. Sledujteto zatím prošlo ručními testy API a HTTP Range z českého PC, nikoli testem na Oracle nebo ve Stremio iOS.

## Dostupné doplňky

| Doplněk | Co nabízí | Potřebuje účet? |
| --- | --- | --- |
| 🎬 **SKTOnline Direct** | Přímé video streamy a dostupné titulky. | **Ne** |
| 🧲 **SKTorrent P2P** | Torrentové zdroje včetně informací o kvalitě a seederech. | **Ano, SKTorrent** |
| 🍿 **Bombuj** | Filmy, seriály, katalogy a dostupné možnosti přehrávání. | **Ne** |
| ▶️ **Přehraj.to Direct** | Původní streamy bez účtu a volitelné přihlášení běžným registrovaným účtem přes API v2 (test). | **Ne; účet je volitelný** |
| 🧪 **HellSpy Direct TEST** | Přímé CDN odkazy na původní videa a všechny dostupné VTT titulky. Zatím experimentální. | **Ne** |
| 🧪 **Sledujteto Direct TEST** | Přímé MP4 odkazy z autorizovaného vyhledávání, dostupné přímé VTT titulky. Zatím experimentální. | **Ano, Sledujteto** |

Každý zdroj funguje nezávisle na ostatních. Když u jednoho filmu něco nenajdeš, můžeš zkusit jiný doplněk.

## Hlavní funkce

- 🎬 **Filmy a seriály** z několika různých zdrojů přímo ve Stremiu.
- 📺 **Výběr kvality** podle dostupných verzí videa.
- 🇨🇿 🇸🇰 **Přehledné označení jazyků** tam, kde je dokážeme rozpoznat.
- 💬 **Titulky**, pokud jsou u konkrétního videa dostupné.
- 🔍 **Vyhledávání a katalogy** podle možností jednotlivých doplňků.
- ⚡ **Rychlejší načítání** díky průběžným optimalizacím vyhledávání.

## Instalace

1. Otevři **[konfigurační stránku](https://130.61.49.108/stremio-addons/configure)**.
2. Vyber doplněk, který chceš používat. **SKTorrent P2P** a testovací **Sledujteto Direct TEST** vyžadují vlastní účet. U **Přehraj.to** lze volitelně zadat i bezplatný účet, nebo pokračovat bez přihlášení.
3. Použij vygenerovaný instalační odkaz a přidej doplněk do **Stremia**.

Doplňky můžeš kdykoliv přidávat samostatně. Není nutné instalovat celou sadu.

### Porovnání se Streamletem (testovací větev)

Vybrané zdroje jsou **HellSpy, SKT Online, Přehraj.to a Sledujte.to**. Webshare ani Fastshare nepřidáváme.

- **HellSpy:** oddělené vyhledání souboru od získání přímé HTTPS adresy. Až 50 výsledků v jednom vyhledání; když první dotaz nic nenajde, maximálně další dvě varianty celého názvu. Při HTTP 429 žádné další pokusy. Platné VTT titulky zůstávají zachované.
- **SKT Online:** zachována existující vyhledávací a streamovací logika, včetně přesné shody epizod a stránkování. Nepřidáváme duplicitní resolver.
- **Přehraj.to:** zachováno přehrávání bez přihlášení. Nový **volitelný testovací** postup login → vyhledávání v API v2 → získání `download_link`. Když se přihlášení nebo odkaz nepodaří, původní nezávislý guest resolver může dál fungovat. Žádný požadavek neobchází omezení účtu.
- **Sledujte.to:** rozšířený omezený offset paging (max. 3 strany, jen pokud na předchozí straně nebyl validní výsledek), podporované alternativní názvy JSON polí pro link a VTT, přímé CDN adresy bez proxy.

Model odděleného `stream_search` a `link` vychází z [veřejné dokumentace Streamlet](https://streamlet.info/dev). V iOS IPA byl přibalen pouze TMDB modul; samotné aktuální JSON definice poskytovatelů nebyly v době rozboru dostupné. Konkrétní API v2 Přehraj.to proto zatím považujeme za experimentální, dokud se neověří funkčnost na běžném registrovaném účtu.

Žádný z těchto testovacích zdrojů se zatím automaticky nenasazuje z této větve na Oracle.

### Sledujteto Direct TEST – omezení testovací verze

- Přihlašování používá rozhraní `/api/v1/token`, vyhledávání `/api/v1/videos` a přímý odkaz `/api/v1/video/{id}/link` z Kodi doplňku Sledujteto.
- Údaje o účtu jsou v instalaci součástí **šifrovaného konfiguračního tokenu**. Instalační URL je i tak citlivá a nesmí se veřejně sdílet. Nezapisuj ji do issue, logů ani screenshotů.
- Server získává jen metadata a podepsanou adresu videa. Vlastní MP4 nepřenáší, nestahuje ani neukládá.
- Bezplatný účet v ručním testu vrátil video URL a CDN odpovědělo `206 video/mp4` na dva jednorázové Range požadavky. **To nepotvrzuje plné přehrání, životnost odkazu ani nárok na neomezené přehrávání**.
- Nyní se nabízejí jen přímé VTT titulky; odkazy na SRT se nepřevádějí. Přesné epizody filtrujeme podle označení sezóny a epizody.
- Doplněk má vlastní instalační token a volitelné propojení se Sosáčem; nezasahuje do vyhledávání HellSpy, Přehraj.to a dalších zdrojů.

## Volitelné propojení se Sosáčem

V konfiguraci můžeš volitelně propojit doplňky se svým účtem Sosáč. U podporovaných titulů z jeho katalogu pak mohou být dostupné také streamy z těchto zdrojů.

Propojení je **dobrovolné**. Bez něj ostatní doplňky dál fungují běžným způsobem.

## Kvalita, jazyky a přehrávání

U streamů se snažíme přehledně zobrazit kvalitu, zvukovou stopu a titulky. Například:

**Přehraj.to • 1080p**  
🎧 🇨🇿 CZ  
💬 🇬🇧 EN  
🎬 1080p

Údaj o kvalitě může vycházet z názvu nahraného souboru, takže nemusí vždy odpovídat skutečnému rozlišení online videa. Jazyky a titulky uvádíme podle dostupných informací.

**Přehraj.to** zvládá využít i některé původní MKV uploady, pokud k nim služba nabízí online MP4 verzi. **SKTorrent P2P** používá na rozdíl od přímých zdrojů torrentové přehrávání.

Funkčnost konkrétního streamu závisí na jeho dostupnosti a na možnostech přehrávače ve Stremiu. Některé zdroje proto mohou fungovat na jednom zařízení lépe než na jiném.

## Soukromí a důležité informace

Údaje k SKTorrentu, Sledujteto, volitelnému Přehraj.to účtu a volitelnému propojení se Sosáčem jsou součástí chráněné konfigurace. **Vygenerované instalační odkazy s přihlašovacími údaji nikde veřejně nesdílej.**

Analytika na konfigurační stránce je volitelná a zapne se pouze po souhlasu. Svou volbu můžeš kdykoliv změnit v nastavení cookies.

Jde o **neoficiální komunitní projekt**. Není oficiálně propojen ani podporován službami Stremio, SKTOnline, SKTorrent, Bombuj, Přehraj.to, HellSpy, Sledujteto či Sosáč. Projekt nehostuje samotná videa a dostupnost obsahu se může měnit.

## Podpora

Pokud ti projekt pomáhá a chceš podpořit jeho další vývoj, můžeš využít Buy Me a Coffee. ❤️

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
