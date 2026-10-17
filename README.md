<p align="center">
  <img src="readme-header.svg" alt="Stremio SKTOnline + SKTorrent by CaseyCZ" width="100%" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/CZ-%C4%8Ce%C5%A1tina-38BDF8?style=for-the-badge&labelColor=0284C7" alt="Čeština" />
</p>

<p align="center">
  Neoficiální komunitní addon pro <strong>Stremio</strong>, který kombinuje přímé streamy ze <strong>SKTOnline</strong> a volitelné torrentové zdroje ze <strong>SKTorrent</strong>.
</p>

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/CaseyCZ/stremio.sktonline?style=for-the-badge&label=VERZE&color=38BDF8&labelColor=0284C7" alt="Aktuální verze SKTOnline + SKTorrent" />
</p>

## O projektu

**SKTOnline + SKTorrent** přidává do Stremia přímé SKTOnline streamy, dostupné titulky a volitelné P2P zdroje ze SKTorrentu.

Addon umí pracovat také s položkami z katalogu **Sosáč**. Pomocí vlastní překladové vrstvy dohledá odpovídající titul a nabídne k němu své SKTOnline a SKTorrent zdroje. Samotný Sosáč addon ani jeho repo se nijak nemění.

## Hlavní funkce

- 🎬 přímé SKTOnline streamy
- 📺 výběr dostupných kvalit videa
- 💬 dostupné titulky ve Stremio přehrávači
- 🌍 zobrazení rozpoznaného jazyka zdroje
- 🧲 volitelné SKTorrent P2P zdroje
- 📝 původní název torrentového releasu
- 👥 počet seederů a velikost torrentu
- 🔗 podpora položek z katalogu Sosáč přes vlastní overlay
- ⚡ rychlejší opakované načítání díky cache
- 📱 použití na běžných Stremio klientech na desktopu, Androidu / Google TV a Apple zařízeních

## Přímé streamy a torrenty

SKTOnline zdroje se přehrávají jako **Direct** streamy. Video jde přímo ze zdroje do Stremia.

SKTorrent zdroje jsou zobrazené samostatně jako **P2P**. U nich si Stremio stáhne data přímo přes torrentovou síť.

Díky tomu jsou Direct a P2P zdroje v seznamu přehledně oddělené a uživatel si může vybrat, co chce použít.

## Soukromí a konfigurace

Pro SKTorrent P2P je potřeba vlastní účet na SKTorrentu. Přihlašovací údaje jsou uložené uvnitř šifrované instalační konfigurace a addon je používá jen pro získání potřebných torrentových údajů.

Když přihlášení na SKTorrent vyprší, addon se pokusí přihlásit znovu automaticky — není potřeba addon přeinstalovávat.

Údaje k Sosáči jsou volitelné a slouží pouze pro vlastní překladovou vrstvu `sosac_* → IMDb/Cinemeta`.

V konfigurátoru lze heslo dočasně **zobrazit** a znovu **skrýt**.

Instalační odkaz je citlivý a neměl by se veřejně sdílet.

## Důležité

Projekt je neoficiální komunitní addon a není oficiálně spojen ani podporován službami Stremio, SKTorrent, SKTOnline ani Sosáč.

Repozitář nehostuje video obsah ani torrentová data. Dostupnost jednotlivých zdrojů se může měnit.

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
