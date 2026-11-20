# Ductura — kanonski plan razvoja, integracije i objave

Ovo je glavni plan za cijeli proizvod. Redoslijed i uvjete prolaza određuju ovdje opisane faze. Linear vodi izvršne zadatke, GitHub nosi izmjene i dokaze, a `_raspored/red.json` služi postojećem orkestratoru za dodjele. Prihvaćene odluke, Ustav, ugovori, inventari ekrana i auditi ostaju izvori zahtjeva i dokaza. Datirani opisi u donjim poglavljima daju povijesni kontekst. Aktualne odluke i prilozi zadataka imaju prednost nad starijim procjenama i putanjama.

**Cilj** je pouzdan proizvod u kojem se student prijavi, otvori svoj rad, piše, spremi, ponovno otvori istu potvrđenu reviziju, preda je i nastavniku prikaže upravo tu predaju. Pilot uključuje sigurnu administraciju ustanove, izolaciju računa, oporavak podataka i pristupačnost. Razvoj se nastavlja prema svim funkcionalnim cjelinama iz poglavlja „Funkcionalni opseg proizvoda”.

## Arhitektura i granice rada

| Dio                                      | Odgovornost                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Aplication_front` i `Aplication_server` | Administracija platforme, iniciranje i praćenje otvaranja ustanove. Pristup studentskom sadržaju traži zasebnu ovlast.                                                                                  |
| `Institution_server`                     | AAI@EduHr, sesije, upravljanje ovlastima i RLS, institucionalni API, evidencija, predaja, migracije, objekti i konfiguracija spremnosti.                                                                |
| Next.js institucionalni frontovi         | Jedan dokazano aktivan ulaz za temeljni tok. Ekrani preko `/api/v1`, zajednički editor i UI paketi, lokalni dnevnik i adapter sinkronizacije. Mobilni i ostali preglednici dijele ugovore i komponente. |
| Preloader i edge                         | Javni ulaz na `ductura.org`, usmjeravanje prema stvarno dostupnom frontu i manifest preuzimanja.                                                                                                        |
| Radnik institucijskog servera            | Zaseban izvršni proces za odgođeni potpis, oporavak, planirane izvoze i odobrene poslove nad podacima. Web proces zadržava postojeće sigurnosne granice.                                                |
| Windows i macOS                          | Tanke ljuske istog web proizvoda, s odvojenim prihvatom prijave, izvornog događaja, potpisa, instalacije i distribucije.                                                                                |

Radne kopije i artefakti nalaze se lokalno na stolnom računalu u `D:\Ductura`. Codex se vodi s laptopa, a projektne izmjene izvode se preko Desktop Commandera u tim radnim kopijama. Na stolnom se pokreću samo potrebne provjere i postojeći projektni procesi kada su odobreni. Koristi se postojeći orkestrator i njegova evidencija preklapanja. Vlasništvo, grana, putanje i kriterij prihvata potvrđuju se prije paralelnog pisanja. Kod za migraciju ide na migracijske grane, prema važećim pravilima i D-97.

## Kritični put i uvjeti prolaza

1. **Faza 1 — kopija i osnovica.** Očuvati migracijsku osnovicu, evidenciju prenesenih migracija i testova, točne repozitorije, grane i commitove. Zasebno bilježiti rezultate povijesne arhive, `main` i migracijskih grana.
2. **Faza 2 — osposobljavanje.** Svaki obuhvaćeni repo mora imati čist typecheck, gradnju i tražene zelene testove. Ugovori prethode klijentima. Shema, vektori uspjeha i grešaka, lažni poslužitelj, objavljeni paket i stvarni handler zasebni su dokazi. Za #350 i #352 evidentirati rezultate provjera aplikacije i DB testova, PostgreSQL/pgTAP i stvarni rezultat S3 provjere. ZEL paketi ulaze po vlastitom prihvatu i ovisnostima. Prije spajanja razlikovati ciljani lokalni test od cjelovitog CI-ja.
3. **Faza 3 — lokalna integracija.** Jedan dokumentirani ulaz podiže stvarni API, PostgreSQL, lokalni OIDC, pohranu, Next.js front i preloader. Slijede VS-1, VS-1b, predaja i nastavnikov pregled, administracija i pristup, mobilni prolaz te zaseban oporavak povrata. Stog koristi sintetičke podatke. Kriteriji su u sljedećoj matrici.
4. **Faza 4 — `main`, repo po repo.** Zeleni CI i jedan ciljani kritični pregled po repozitoriju obuhvaćaju autentikaciju, RLS, dokaze i predaju. Preloader ide posljednji, nakon provjere odredišta i odluke za javnu domenu. Produkcijski sustav i produkcijski AAI imaju vlastite dokaze spremnosti.
5. **Faza 5 — objava.** Serveri na Renderu, frontovi na Vercelu prema odobrenoj konfiguraciji. Objava traži izričitu vlasnikovu odluku. Pilot je zasebno odobrenje na jednom sustavu prema §4d, s potvrđenim VS-1b, povratom, operativnom spremnošću ustanove i pristupačnošću.

**Prvi dokaz** je DAN-887. Zadržati DAN-759 kao postojeći zadatak za stog i u DAN-887 dovršiti povezivanje weba i preloadera. U WEB-14b i DAN-1022 provjeriti host koji pokreću zadani `dev/build/start` i koji otvara preloader. Portovi 5173 i 3000 služe provjeri stvarnog ulaza. Jedan vlasnik pokreće lokalni OIDC. Launcher mora koristiti stvarne skripte, ispravni `APP_ORIGIN`, `APP_DATABASE_URL` i zajednički provisioning token. Obvezna usluga koja nedostaje daje čitljivu preflight grešku. Integracijski prolaz otvara editor kroz uobičajeni ulaz bez ručnog prebacivanja porta. Potpis protokola 1 provjerava DAN-1023. Za stvarne podatke vrijedi protokol 2 uz VS-1b. [DAN-887](https://linear.app/daniel77/issue/DAN-887/ductura-vs-1-izvrsni-sistemski-run-sa-svim-tvrdnjama-vs-11-do-vs-113-i) · [Ugovor prijave i otvaranja ustanove](https://github.com/danielrisavi77-create/Ductus/issues/2028#issuecomment-6993786629)

## Sistemski prihvat — deset scenarija iz audita

Za svaki red spremiti rezultat, naredbu, stvarnu testiranu reviziju svakog uključenog repoa i vezu na artefakt. Knjižiti odvojeno `PROLAZ`, `PAD` ili `NEPROVEDENO`. Sintetički testni podaci imaju jedinstven ID. Status ticketa potvrđuje tijek rada, a artefakt potvrđuje tehnički rezultat.

| ID  | Vlasnik postojećeg rada                                              | Izvršni prihvat                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Preloader / DAN-939, DAN-933, VS-2                                   | Iz početnog URL-a stvarni web i mobilni odabir otvaraju odgovarajući host. Uključi iPad s desktop identitetom, vraćanje na stvarno podržani prikaz, te dostupna i nedostupna odredišta. Svaka ponuđena desktop poveznica preuzima stvarni paket s očekivanim hashom. Nepostojeći paket nema ponuđen gumb.                                                                             |
| A02 | Platforma i Institution_server / provisioning                        | Sintetički platformni admin otvara ustanovu. BFF i server dijele pravilo issuera i vremenski budžet ili trajan ID zahtjeva s praćenjem stanja. Ponovni isti zahtjev ne stvara drugu ustanovu. Odvojeni prijavni pokušaji ne blokiraju druge račune. Imenovanje prvog admina je potvrđeno, zabilježeno i provjerljivo. Tijelo zahtjeva ograničava se prije nekontroliranog učitavanja. |
| A03 | Platforma i identitet / DAN-759, DAN-887                             | Nova sintetička ustanova ulazi kroz isti edge i lokalni AAI/OIDC s ispravnim issuerom, povratnom adresom i sesijom. Zasebno se prikazuju spremnost za prijavu, konfigurirana domena evidencije, objekti i ključevi te operativna spremnost. Otvaranje rada u nekonfiguriranoj ustanovi sigurno se odbija.                                                                             |
| A04 | WEB-08, WEB-17, WEB-20 i pripadni SRV                                | Svaka uloga otvara stvarni početni ekran i vidi samo dopuštene radnje. Duboka poveznica, query/hash, aplikacijski prefiks te stanja učitavanja, praznog rezultata, pogreške i ponovnog čitanja provjeravaju se iz aktivnog hosta.                                                                                                                                                     |
| A05 | DAN-887, DAN-1022, DAN-1023                                          | U pravom editoru upis se prvo zabilježi na uređaju. Potvrđeno stanje dolazi tek nakon provjere potpisa za istu transakciju, dokument i reviziju. Osvježavanje iz čistog konteksta vraća istu rečenicu, reviziju i hash. Stari zakašnjeli odgovor ne potvrđuje noviji tekst.                                                                                                           |
| A06 | DAN-887 / VS-1.13                                                    | Ponovno pokretanje servera i svjež kontekst preglednika vraćaju isti dokument kroz API u studentskoj sesiji. Usporediti `documentId`, reviziju, tekst i neovisni hash te zapisati `vs-run.json`.                                                                                                                                                                                      |
| A07 | VS-1b / DAN-822, DAN-823, DAN-824, DAN-1024                          | Izgubljeni odgovor, prekid mreže i ponovno slanje istog sadržaja istim ključem daju jednu reviziju. Nakon `202 pending_signature` prekid radnika i oporavak daju točno jednu valjanu potvrdu iste revizije. Potvrđeno stanje čeka provjeren potpis.                                                                                                                                   |
| A08 | SRV-18–25, WEB-22–28, WEB-30–36 / DAN-856, DAN-858, DAN-311, DAN-316 | Predati potvrđeni V1 dok nastaje lokalni V2. Utrka i dvostruka predaja imaju jedan ishod. Nastavnik, komentar, opetovano preuzimanje potvrde i izvoz vezani su uz V1. Usporediti reviziju i hash na svim površinama.                                                                                                                                                                  |
| A09 | Institucijske ovlasti, stvarni dist server / DAN-858 i RLS           | Student i nastavnik pokušaju pristup tuđem radu i drugoj ustanovi. Nakon ukidanja pripadnosti, uloge ili odnosa postojeća sesija i novi poziv gube pristup, uz propisani zapis. Test koristiti kroz HTTP i stvarnu aplikacijsku DB ulogu.                                                                                                                                             |
| A10 | SRV-JS → WEB-14c / `journalScope` iz `/me`                           | Dvije stvarne kartice, više nepotvrđenih radova i isti uređaj. Odjava A zaustavlja staru karticu i uklanja prethodni prikaz. B nema pristup A-ovom dnevniku. Nakon povratka A dobiva vlastite lokalne izmjene. Izostao ili nevaljan scope zatvara pristup.                                                                                                                            |

Scenariji A02–A04 i A08–A10 pripadaju prihvatu integracije. VS-1 ne čeka potpisnog radnika, puni provisioning ni nastavničku predaju. Ta podjela omogućuje rani stvarni dokaz bez sužavanja konačnog prihvata.

### Pilot, operacije i dokumentacijske obveze

- DAN-889 vraća bazu i objekte u čisti stog, mjeri vrijeme i provjerava istu sintetičku reviziju. Provjeriti i povrat na stariju reviziju poslužitelja, ponovno slanje lokalnih koraka i novu potpisanu reviziju s oznakom obnove. Ciljeve RPO/RTO i rokove čuvanja potvrditi na temelju mjerenja i vlasničkih odluka. DAN-297/D-30 i M10 vode retention i izvršenje brisanja.
- DAN-428 provjerava WCAG 2.2 AA za proizvod. Matrica DAN-755 uključuje stvarni preglednik, tipkovnicu, fokus, mobilni raspored i čitač zaslona. Automatski axe rezultat je jedan dio dokaza.
- Prije pilota uskladiti autentični Ustav i proizvodne reference s prihvaćenim dopunama. D-260 vodi naknadnu provjeru tekstualne podudarnosti s izvorima i odlomcima, uz zabranu korištenja postotka kao procjene AI-ja, ljudskosti, autorstva ili osnove za automatsku sankciju.
- Povezati odluku o potvrđivanju prvog administratora, rokove čuvanja i ciljeve oporavka. Na neriješenim stavkama evidentirati vlasnika, točnu odluku koja nedostaje i ovisni zadatak. Prihvaćeni scope dnevnika primjenjuje se kroz SRV-JS/WEB-14c.
- U prijelaznom i pilot prihvatu razlikovati CI, lokalnu integraciju, staging i produkciju. Povijesni audit ZIP-a daje nalaze za vlastite revizije. Pogreške poput query/hash, retryja te stare demo utrke najprije provjeriti na ciljnoj migracijskoj grani. Audit sažetak donosi deset scenarija iz gornje matrice. Pojedinačne dokaze za svih 27 nalaza preuzeti iz cjelovitog izvještaja kad bude dostupan.

## Funkcionalni opseg proizvoda

Valovi su skupine značajki unutar pet faza. Ugovori, server i web mogu se pripremati paralelno uz potvrđene ulaze, vlasništvo i ovisnosti. Valovi koji ovise o prethodnom prolazu idu iza njega. Oznake M0–M11 i valovi služe povezivanju obveza i postojećih zadataka.

| Val | Obuhvat                                                                              | Uvjet ili dokaz                                                                                                   |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Jezgra editora i Next.js, pisanje, lokalni dnevnik, server i potpis                  | A05–A07 i VS-1/VS-1b.                                                                                             |
| 2   | Student, prijava, moji zadaci, kolegiji, radovi, upis kodom i obavijesti             | Stvarna uloga i ovlaštenja, jasna stanja, ponovno čitanje, sigurna upotreba koda.                                 |
| 3   | Radni prostor studenta, Izjava, predaja, potvrda                                     | Nakon temelja 1, 2 i 4. A08, jedan ishod predaje i provjerljiva potvrda.                                          |
| 4   | Nastavnik i administrator, kolegiji, novi zadatak i verzije, izdavanje i opoziv koda | A02–A04. Otvaranje, uređivanje i posljedice verzije zadatka provjerene kroz mrežu i ovlasti.                      |
| 5   | Nastavnik vidi predaju, rosters, napomene i mentorstva                               | Nakon predaje. A08–A09 i stvarna projekcija predane revizije.                                                     |
| 6   | Ljuska editora, trake, paneli, ladice, radne affordance i pristupačnost              | Isti stvarni editor i žarište tipkovnice, bez narušavanja spremanja.                                              |
| 7   | Citati, izvori i razvoj sheme v3                                                     | Identičan kanonski sadržaj kroz unos, pohranu, ponovno otvaranje i kompatibilnu migraciju sheme.                  |
| 8   | Mentorova suradnja, komentari, dorade, prijedlozi, brzi put                          | Veza s ispravnim dokumentom i verzijom, kontrola pristupa, audit i opoziv.                                        |
| 9   | Procesni sažetak, reprodukcija, usporedba i javna provjera                           | Dokaziva rekonstrukcija i dopušteni prikaz, uz granice Ustava.                                                    |
| 10  | Bogati sadržaj, stranice, shema v4, uvoz i izvoz                                     | Sljedivost verzije i istih bajtova preko spremanja, predaje i izvoza.                                             |
| 11  | Provjere teksta, etape, konzultacije, Merlin, produljenje                            | Odobren D-260 opseg nakon pilota. Primijeniti zasebne institucionalne odluke za rokove, pristup i izvoz.          |
| 12  | AI pomoćnik                                                                          | Ograničen važećim pravilima, dopuštenom obradom podataka, zasebnom odlukom i dokazom konkretne korisničke radnje. |

Poprečne cjeline obuhvaćaju M0 temelje i CI, M1 AAI identitet, M2 ustanove, M3 evidenciju, M4 Lektu i akademska pravila, M5 editor, M6 suradnju, M7 predaju, M8 uvoz/izvoz, M9 pomoćnika, M10 privatnost, podatke i izvršenje prava, te M11 GO uvjete. Životni ciklus produkcije obuhvaća observability, backup, redovne vježbe povrata, incidentne postupke, ažuriranje paketa, pristupačnost i korisničku podršku. Za svaki dio vrijedi isti testirani ugovor, provjerljiv prihvat i status prema postojećem Linear zadatku.

## Izvori, prednost i održavanje

U nastavku ostaju izvorne odredbe migracije i katalog tehničkih zadataka iz ukinutih zasebnih planova. Oznake faza, SKU-ovi paketa, povijesne procjene i stanja u izvornim redcima treba tumačiti uz aktualnu odluku, stvarnu granu i izvršni zadatak. Putanje iz starih ugovora potvrđuju se prije pisanja. Primjer je API registar u `server/contracts` s TypeBoxom i vektorima te ponovnom generacijom OpenAPI-ja. [Odobreni opseg API ugovora](https://github.com/danielrisavi77-create/Ductus/issues/2028#issuecomment-7022752457)

Kada se obveza promijeni, ažurirati ovaj dokument ili njegov katalog te postojeći Linear zadatak. GitHub PR nosi pregled izmjene. Prototipovi, inventari i auditi mogu biti zasebne referentne datoteke. Plan aktivnosti i uvjeti prolaza održavaju se ovdje.

## Odredbe migracije i prihvaćene odluke

Stanje: 19. 11. 2026. · Sastavio orkestrator · Redoslijed rada je od 19. 11. 2026. u pet faza (odjeljak „Pet faza”). Ostatak dokumenta je od 14. 11. (dopunjen odlukom vlasnika O-1 do O-3, Ductus#87 c.6880835493). Gdje se razilazi s odjeljkom „Pet faza”, vrijedi on.

**Tvoja odluka, 14. 11. 2026.:**

> „Želim da krenemo s ovom migracijom i na ovaj način: Ductura će imati sedam zasebnih repozitorija, svaki sa svojom granom main, vlastitim funkcionalnim testovima i testovima pomoćnih funkcija. Preloader je sedmi razvojni dio. Korisnik će na jednoj domeni moći otvoriti odgovarajuće web-sučelje ili preuzeti desktop aplikaciju.”
>
> „Prvo možeš napraviti plan točni što i kako i dati svoje prijedloge s obzirom na stanje repozitorija i plan rada.”

**Što se mijenja:** `shared-core` više nije sedmi repozitorij. Na njegovo mjesto dolazi `preloader`. Sve ostalo što je odlučeno 14. 11. vrijedi i dalje: potvrđeni plan servera i weba, popis zadataka S-0.1 do S-1I, redoslijed „server, pa web od komponenata, pa desktop”.

**Izvori:** ugovori i odluke povezani su u ovom dokumentu, s tehničkim stavkama u [katalogu zadataka](#katalog-zadataka).

---

## Ispravci od 14. 11. 2026.

Vlasnik je 14. 11. odobrio sljedeće ispravke (Ductus#87, c.6879745570 i c.6879325032). Gdje se ostatak dokumenta s njima razilazi, vrijede ispravci. Ugrađeni su na mjestima označenima „(ispravak 14. 11.)”.

1. **Registar paketa je GitHub Packages**, ne npm (§2c, §8 točka 9, §9 redak 2).
2. **V-1b je podijeljen:** „web i preloader, odobreno 14. 11.” (ne čeka fazu C) i zasebna radnja „Faza E · aktivacija desktop razvoja” (§4).
3. **Tri odvojena izlaza po ruti** (§1b): shema postoji, ugovorna integracija prolazi, stvarni sistemski tok prolazi. Sama shema ne otključava web 2.c3 i 2.c4.
4. **Kriterij prihvata VS-1** (§4a): sintetički student se prijavi kroz lažni OIDC, spremi rečenicu i nakon osvježavanja je vidi. Ovisi o DAN-758, DAN-759 i DAN-760.
5. **Izdavatelji paketa** (§2c): koji repozitorij objavljuje koji paket `@ductura/*`.
6. **Redoslijed V-2** (§7): prvo dokaz prolaza i očekivanog pada u serveru (S-0.9, S-0.10-b), zatim V-2 dopisuje točna imena statusa. Spajanje ide po pravilu iz §7 (17. 11.).
7. **U11** (§7) traži vlasnikovu potvrdu teksta pravila.
8. **Nazivi repozitorija:** `web-chrome` je preimenovan u `web` (u §2d je to već zamijenjeno). `web-mobile` i `web-other` su arhivirani, pa se u ostatku dokumenta tri web repozitorija čitaju kao jedan repozitorij `web`.
9. **Odluka vlasnika O-1, O-2, O-3 (14. 11., Ductus#87 c.6880835493, dopuna c.6880861260):** pilot na jednom sustavu (§4d), VS-1 u dva koraka s novom stavkom VS-1b i tvrdnjom VS-1.13 (§4a-1), uski rez servera iza S-0.19 (§4c), novi odjeljak „Rizici” R-1 do R-10 (§8a). Gdje se ostatak dokumenta s tim razilazi, vrijedi ta odluka. Točke 4 i 5 odluke (niža revizija na poslužitelju, pravila rada za ductura/*) nisu dio ovog plana; točka 4 je odlučena (varijanta A, Ductus#87 c.6880906459) i zapisana u §8a kao R-8.
10. **Domena je `ductura.org`** (odluka vlasnika 17. 11. 2026., Ductus#2012 c.6934113245): zamjenjuje prijašnji primjer i izbor između dvije domene (§1c, KARTA §3 i §4). V-0 ostaje otvoren zbog adrese e-pošte, pa R-4 i V-5 i dalje čekaju njegov konačan oblik.
11. **Pet faza (odluka vlasnika 19. 11. 2026., koordinacija Ductus#2028):** zamjenjuju valove 1–10 i vrata „review i QA po PR-u” za migraciju. Vidi odjeljak „Pet faza” niže.

---

## Pet faza (od 19. 11. 2026.)

Koordinacija: Ductus#2028.

**Odluka vlasnika, 19. 11. 2026.:** Daniel je predložio dvije promjene plana, pa je rekao:

> „možeš napravi oboje što sam im predložio, odabrati.”

Time je odobreno:

1. Plan migracije piše se u pet faza umjesto u valovima 1–10.
2. Za fazu 4 vrata su zeleni CI i **jedan** ciljani pregled kritičnih dijelova po repozitoriju, umjesto reviewa i QA-a po svakom PR-u.

O frontovima je Daniel 19. 11. rekao:

> „Sve treba biti na next.js od fronta”

### Pregled

| Faza                          | Što                                                        | Vrata                                                 |
| ----------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| 1. Kopija                     | Doslovna kopija Ductusa na grane za migraciju.             | Gotovo.                                               |
| 2. Osposobljavanje na granama | Svaki repo: tsc 0 grešaka, zeleni testovi, gradnja.        | Orkestrator testira lokalno i spaja u granu.          |
| 3. Lokalna integracija        | Server, baza i frontovi zajedno, lažni OIDC; tokovi redom. | Svi tokovi prolaze.                                   |
| 4. Grana → `main`             | Repo po repo; Preloader zadnji.                            | Zeleni CI i jedan ciljani pregled kritičnih dijelova. |
| 5. Objava                     | Serveri na Renderu, frontovi na Vercelu.                   | Samo na Danielovu riječ.                              |

### Faza 1. Kopija (gotovo)

Doslovna kopija Ductusa na grane za migraciju:

- `migracija/kopija-ductus-front`
- `migracija/kopija-ductus-backend`
- `migracija/kopija-ductus-testovi-server`
- `migracija/nextjs`: frontovi Preloader, Institution_web_mobile i Web_other.

### Faza 2. Osposobljavanje na granama

- Svaki repo ima tsc bez grešaka, zelene testove i uspješnu gradnju (`next build` ili pokretanje servera).
- Svi frontovi su na Next.js. Podaci idu samo preko Institution_servera `/api/v1`, nikad iz baze.
- Pisci otvaraju PR prema grani migracije. Orkestrator testira lokalno i spaja u granu.
- **Nema reviewa ni QA-a po PR-u.** Vrata su lokalni test orkestratora.
- Preostale stavke starih valova 1–10 prelaze u ovu fazu.

**Dopuna 19. 11. 2026. (Daniel, 23:05: „Može sva 3 da”):**

- Zadaci kreću i kad baza repoa još nije zelena. U repo s crvenom bazom spajaju se samo zadaci `ZEL-*`, koji bazu popravljaju. Ostali gotovi PR-ovi čekaju na popisu `_raspored/cekaju-zelenu.txt` i spajaju se redom kad baza pozeleni.
- Web zadaci ne čekaju serverske rukovatelje. Grade se prema ugovorima `/api/v1` s lažnim podacima u testovima. Gdje ugovora još nema, u kodu stoji `TODO(ugovor)`. Serverska ovisnost zapisana je u `srvDeps` i provjerava se u fazi 3.
- **Iznimka od „nema reviewa”:** PR koji dira kritični dio dobiva jedan neovisni review na točnom headu prije spajanja u granu. Kritični dijelovi su prijava i sesije (AAI@EduHr, D-09), RLS, dokazi i forenzika (B-8) te predaja. Tako faza 4 ne otkriva te greške tek na kraju.

### Faza 3. Lokalna integracija

- Server, baza i frontovi rade zajedno. Prijava je lažni OIDC.
- Tokovi redom: student piše → sinkronizacija → predaja → nastavnik vidi i pregledava → administrator ustanove.
- Migracija je gotova tek kad ti tokovi prolaze.

### Faza 4. Grana → `main`, repo po repo

- Vrata su **zeleni CI i jedan ciljani pregled kritičnih dijelova** u tom repou. Nema reviewa i QA-a po svakom PR-u.
- Kritični dijelovi koje pregled pokriva:
  - dokazi i forenzika (B-8),
  - predaja,
  - prijava AAI@EduHr (D-09, D-16),
  - RLS.
- **Preloader ide zadnji.** Njegov `main` objavljuje ductura.org. Prije toga treba zamijeniti `.invalid` hostove.

### Faza 5. Objava

- Serveri idu na Render, frontovi na Vercel.
- Samo na Danielovu riječ.

### Što se ne mijenja

- Proizvodna pravila, odluke i rokovi ostaju: kontrolne točke 30. 11. i 15. 1., proba 22. 2. 2027.
- U Ductusu se ništa novo ne gradi.

### Povijesna bilješka: valovi 1–10

Valovi 1–10 (S-1A do S-1I) nisu građeni zadatak po zadatak. Preuzeti su kopijom (faza 1). Preostale stavke prelaze u fazu 2. Raniji redoslijed A–E (§4) i vremenska procjena (§4b) vrijede samo kao povijest.

### Valovi 11–18 (funkcije M1–M11)

Valovi 11–18 kreću **nakon faze 3**. Grade se izravno u Ducturinim repozitorijima istim ritmom: PR, lokalni test, spajanje.

---

## 0. Ukratko

- Sedam repozitorija u organizaciji `Ductura`. Svaki ima svoj `main`, svoj CI, svoje testove i isti gate.
- Svi klijenti razgovaraju samo sa serverom, preko njegova HTTP API-ja (`/api/v1`) i ugovora (OpenAPI).
- Preloader je jedini ulaz na domeni. On bira web-sučelje i nudi desktop paket.
- Zajednički kod dijelimo **verzioniranim paketima**, ne osmim repozitorijem. Editor i sinkronizacija imaju **jednu** implementaciju (`@ductura/editor-core`), a server objavljuje klijent API-ja (`@ductura/contracts`).
- Desktop je tanka izvorna ljuska oko istog web paketa. Editor se nikad ne piše iznova.
- Rano gradimo **vertikalni presjek**: prijava, otvaranje rada, spremanje rečenice i osvježavanje, kroz preloader, web-chrome i server.
- Redoslijed rada od 19. 11. 2026. je pet faza (odjeljak „Pet faza”). Redci u nastavku o valovima 1–10, o fazama A–E i o reviewu i QA-u po PR-u opisuju raniji plan.
- Raniji redoslijed bio je: prvo server (val 0 i dalje), zatim preloader i web-chrome, zatim web-mobile i web-other, desktop na kraju.
- Mjerimo od prvih zadataka koliko nas razdvajanje košta (§8, prijedlog 17).
- Ductus ostaje živ dok novi web ne preuzme glavni tok. Onda ga zamrzavamo (ne prije izbora sustava za pilot 20. 12. 2026., §4d), a kasnije zaključavamo samo za čitanje.

---

## 1. Ciljna slika

### 1a. Sedam repozitorija

| Repo                      | Što posjeduje                                                                                                                                                                                                                                                | Što nikad ne smije sadržavati                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `Ductura/server`          | API `/api/v1`, prijava AAI@EduHr (D-09), FIDO2 za operatere, ovlasti, sve baze (glavna, zapisi, pravni tekstovi), migracije i pgTAP, radnici u pozadini, zapisi i metrika, backup, manifest i ruta za preuzimanje, testni server, ugovor (OpenAPI i vektori) | Stranice, React, CSS, editor, Dexie. Ništa što ovisi o pregledniku.                           |
| `Ductura/preloader`       | Prvi ekran, provjera servera, prepoznavanje okruženja, odabir sučelja, gumb za paket, stranice grešaka, traka kolačića i pristanak, ulaz u prijavu, javna info stranica (3e), javni pravni tekstovi, stranica za preuzimanje, pravila usmjeravanja na domeni | Pristup bazi. Odluke o ovlastima. Otisak preglednika (fingerprinting). Editor i radni ekrani. |
| `Ductura/web-chrome`      | Sučelje za Chrome na računalu: editor, dnevnik, sinkronizacija, ekrani studenta, nastavnika i admina                                                                                                                                                         | Serverski kod, rute API-ja, tajne, izravne veze na bazu. Kod za mobitel i ostale preglednike. |
| `Ductura/web-mobile`      | Sučelje za mobitele i tablete: dodir, zaslonska tipkovnica, rotacija, uski zaslon                                                                                                                                                                            | Isto kao web-chrome.                                                                          |
| `Ductura/web-other`       | Firefox, Safari, Edge, Opera i ostali preglednici na računalu. **Prijedlog: tanki repo za kompatibilnost i testove, ili ga nema** (§8, prijedlog 16; odluka 13)                                                                                              | Isto kao web-chrome. Vlastiti editor ili vlastite ekrane.                                     |
| `Ductura/desktop-windows` | Windows aplikacija, instalacijski paket, potpis paketa, prvo pokretanje                                                                                                                                                                                      | Vlastiti server ili baza. Druga prijava osim one preko servera.                               |
| `Ductura/desktop-macos`   | macOS aplikacija, paket, potpis i notarizacija kod Applea                                                                                                                                                                                                    | Isto kao Windows.                                                                             |

### 1b. Kako razgovaraju

- Jedini put do podataka je HTTP API servera. Nijedan klijent ne zna kako izgleda baza.
- Ugovor je OpenAPI datoteka u serveru (S-1H.1-b). Iz nje se automatski stvara klijent za web i desktop.
- Server objavljuje testne vektore (S-1H.4). Svaki klijent ih pokreće u svom CI-ju.
- Klijenti međusobno ne razgovaraju. Preloader samo preusmjerava korisnika na pravo sučelje.
- Pisanje u evidenciju, predaje i revizijski trag ide samo kroz RPC na serveru, kao danas.
- **Tri odvojena izlaza po ruti (ispravak 14. 11.):** (1) shema rute postoji (priprema sučelja), (2) ugovorna integracija prolazi (vektori U7 i U8, objava paketa u U10), (3) stvarni sistemski tok prolazi. Sama shema ne otključava web 2.c3 i 2.c4: 2.c3 čeka objavljeni paket iz servera (U10), a 2.c4 čeka 2.c3, shemu, vektore (U7, U8) i oznake iz 2.c1.

### 1c. Jedna domena: prijedlog usmjeravanja

**Preporuka: jedna adresa i podputanje.** Primjer na `ductura.org` (domena odlučena 17. 11., ispravak 10):

| Putanja         | Tko je poslužuje                                                    |
| --------------- | ------------------------------------------------------------------- |
| `/`             | preloader (prvi ekran, info stranica, pravni tekstovi, preuzimanje) |
| `/c/`           | web-chrome                                                          |
| `/m/`           | web-mobile                                                          |
| `/o/`           | web-other                                                           |
| `/api/v1/`      | server                                                              |
| `/preuzimanje/` | paketi, preko manifesta servera (S-1H.5)                            |

Zašto podputanje, a ne poddomene (`c.ductura.org` …):

1. Kolačić sesije ostaje `__Host-` kolačić. On radi samo na jednoj adresi. S poddomenama bismo morali širiti kolačić na cijelu domenu, a to je slabija zaštita.
2. Nema CORS-a. Sučelje i API su na istom porijeklu, pa postojeća zaštita od zahtjeva s drugog porijekla radi bez promjene.
3. Srce dobiva jednu adresu preusmjeravanja za web (V-5).
4. Jedan certifikat i jedna sigurnosna politika sadržaja (CSP).

Cijena: svaki web gradi se s osnovnom putanjom (`/c/` i sl.). Ispred svega stoji jedan obrnuti proxy. Njegovu konfiguraciju predlažem držati u `preloader` repozitoriju, jer je preloader vlasnik ulaza.

Desktop aplikacija ne koristi kolačić. Prijavljuje se tokom u zaglavlju, po ADR-u S-1E-e.

---

## 2. Zajednički kod bez osmog repozitorija

### 2a. Problem

Tri web sučelja i preloader inače bi kopirali isto: klijent API-ja, tipove, lokale, oznake dizajna „papir i grafit” (D-188) i komponente. Kopije se brzo razilaze. Shared-core više nije repozitorij, pa treba drugo rješenje.

### 2b. Usporedba

| Način                   | Za                                                                                                                     | Protiv                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Verzionirani paketi** | Jasna verzija. Svaki repo bira kad nadograđuje. Automatski prijedlog nadogradnje (Dependabot). Radi s gateom i CI-jem. | Treba objava paketa i malo discipline oko verzija.                                                               |
| Git submoduli           | Nema registra paketa.                                                                                                  | Agenti i oblak često ih krivo kloniraju. Promjena traži dva PR-a i ručno pomicanje pokazivača. Teško se reviewa. |
| Kopiranje               | Najjednostavnije na početku.                                                                                           | Razilaženje je sigurno. Popravak greške treba ponoviti četiri puta.                                              |

### 2c. Preporuka: verzionirani paketi

| Paket                  | Objavljuje ga                                                  | Sadrži                                                                                                                                               | Koriste ga                                                    |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `@ductura/contracts`   | server                                                         | generirani klijent iz OpenAPI-ja, tipovi, katalog kodova grešaka, testni vektori, čisti formati evidencije (JCS, sažeci) iz `server/domain`          | preloader, sva tri weba; desktop koristi OpenAPI datoteku     |
| `@ductura/ui`          | web-chrome                                                     | oznake dizajna (D-188), osnovne komponente, hrvatske lokale sučelja                                                                                  | preloader, web-mobile, web-other                              |
| `@ductura/editor-core` | **najprije Ductus**, zatim web-chrome (`packages/editor-core`) | editor (shema, unos, identitet blokova), dnevnik (Dexie), sinkronizacija s osam stanja, ACK potpisanom potvrdom, odjava i brisanje lokalnih podataka | web-chrome, web-mobile, web-other, desktop (preko web paketa) |

**Izdavatelji paketa (ispravak 14. 11.; prema planovima po repozitorijima):**

| Paket                                                                     | Izdavatelj (izvor i objava)                                                                           |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `@ductura/contracts`                                                      | `server` (`packages/contracts`), objava iz Actionsa na oznaku (U10)                                   |
| `@ductura/test-fakes`                                                     | `server` (`packages/test-fakes`), objava iz Actionsa na oznaku (U10)                                  |
| `@ductura/ui`                                                             | `web` (`packages/ui`, 2.c1)                                                                           |
| `@ductura/parity`                                                         | `web` (`packages/parity`)                                                                             |
| `@ductura/editor-core`                                                    | najprije Ductus (E-0.1, E-0.2 objavljuje 0.x prije VS-1), zatim `web` (`packages/editor-core`, E-0.3) |
| `@ductura/tsconfig`, `@ductura/eslint-config`, `@ductura/prettier-config` | `.github` (`packages/`)                                                                               |

Zašto ovako:

- Server je vlasnik ugovora, pa i paketa ugovora. To je drugi paket: generirani klijent OpenAPI-ja i tipovi.
- **Editor i sinkronizacija imaju jednu implementaciju.** To je najkritičniji i najbolje testirani kod (B-8, F-3: property, ekvivalencijski i odjavni testovi u `src/editor`, `src/lib/journal`, `src/lib/sync`). Druga ili treća kopija bila bi najveći rizik cijele migracije.
- `server/domain` već po planu ne uvozi ništa (S-0.19), pa se može objaviti bez izmjena.

### 2d. Put paketa `@ductura/editor-core` (prijedlog)

1. **Počinje u Ductusu** (E-0.1, E-0.2). Ondje kod već radi i ima testove. U Ductusu se izdvaja u mapu `packages/editor-core` s jasnom granicom: bez Next.js-a, bez poziva na rute Ductusa, transport sinkronizacije kao ulazni parametar. Isti testovi prolaze prije i poslije.
2. Objavljuje se iz Ductusa kao verzija 0.x. Web-chrome ga koristi od prvog dana, bez kopije.
3. **Seli se u web** (`packages/editor-core`) kad su ispunjena sva četiri uvjeta izlaza:
   - web ima potpun gate (CI, review, QA; spajanje po pravilu iz §7) i prošao je vertikalni presjek (§4);
   - svi testovi paketa (unit, property, ekvivalencijski, odjavni) prolaze u webu s istim brojem i ishodom kao u Ductusu;
   - zadnja objava iz Ductusa i prva iz weba daju istu izgradnju (isti testni vektori sinkronizacije i evidencije);
   - Ductus je zamrznut ili se ondje paket više ne mijenja.
4. Nakon selidbe Ductusova kopija postaje samo za čitanje, uz bilješku gdje paket sada živi.

**Tok verzija i nadogradnje:**

1. Svaki paket ima semantičku verziju. Promjena koja lomi daje novu glavnu verziju.
2. Verziju podiže PR koji mijenja paket, zapisom promjene (changeset). Spajanje u `main` pokreće objavu.
3. Klijent prikvači točnu verziju. Dependabot otvara PR za nadogradnju. Taj PR prolazi CI klijenta, s vektorima nove verzije.
4. Server drži staru glavnu verziju API-ja živom dok je koristi bilo koji klijent. Stari desktop paketi time ne pucaju (S-1H.4).
5. Lokalna izrada unutar jednog repoa (npr. `@ductura/ui` u web-chromeu) koristi pnpm workspace, bez objave.

**Registar (ispravak 14. 11.): GitHub Packages**, odluka je donesena. Instalacija i javnog paketa traži token: u CI-ju je dovoljan `GITHUB_TOKEN` s `packages: read` uz dodijeljen pristup repozitoriju, a za lokalni rad osobni token s `read:packages`. Javni npm opseg bio je raniji prijedlog.

---

## 3. Što se seli iz Ductusa i kada

Ductus danas: oko 806 `.ts`, 104 `.tsx` i 217 `.mjs` datoteka; 37 ruta u `app/api`; 99 pgTAP datoteka; oko 100 datoteka u `e2e/`; oko 275 datoteka u `src/components`. Novi repozitoriji pišu skripte samo u TypeScriptu, pa se `.mjs` prevodi pri prijenosu.

Pravilo za svaki prijenos: PR navodi izvorni SHA Ductusa, isti testovi prolaze prije i poslije, a logika se u istom PR-u ne mijenja. Povijest gita se ne prenosi, samo sadržaj (odluka vlasnika, Ductus#87 c.6881719844, točka 13): svaki prijenosni PR navodi izvorni SHA Ductusa.

| Repo                                | Polazište iz Ductusa                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Kada                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **server**                          | Po §9 popisa zadataka: `db/migrations` i ledger (S-0.13), `db/local`, `infra/postgres` (S-0.14), `db/tests` (S-0.15), `infra/fake-oidc` (S-0.16), `src/server/log`, `src/server/db`, `env.ts` (S-0.17), čisti dio `src/server/auth` (S-0.18), dio `src/domain` i `src/adapters` (S-0.19), `src/lib/i18n` za serverske poruke (S-1L.1), zatim logika ostalih ruta (val 6). `src/application` (evidence, jobs, ports, projection) ide uz pripadne rute u valu 6.                                                                                                                   | Faza A i B                                 |
| **preloader**                       | `app/error.tsx`, `app/not-found.tsx`, `app/global-error.tsx` (stranice grešaka); `src/components/auth` (ulaz u prijavu); `src/components/landing` i `how-it-works` (info stranica, bez ustanova); `src/lib/status/public-status`; oznake iz `app/globals.css`, `app/fonts`, `src/components/shell/tokens`. Logika odabira sučelja je nova.                                                                                                                                                                                                                                       | Čista logika rano (P-0.2), ostalo u fazi C |
| **web-chrome**                      | `src/editor`, `src/lib/journal` i `src/lib/sync` dolaze kao paket `@ductura/editor-core` iz Ductusa (§2d), ne kopijom; izvorni kod paketa seli se tek po uvjetima izlaza. Kopijom dolaze `src/client`, `src/components` (bez landinga), stranice `app/rad`, `zadaci`, `zadatak`, `nastavnik`, `ustanova`, `upis`, `stanje`; klijentski dio `src/domain` (document, diff, citation, text, provenance, sync, serverSync, collaboration); UI dio `src/lib/i18n`; `e2e/` za tokove sučelja. Pozivi prema Next.js rutama zamjenjuju se generiranim klijentom iz `@ductura/contracts`. | Faza C                                     |
| **web-mobile**                      | Ništa izravno. Početak je predložak repoa plus `@ductura/ui` i `@ductura/editor-core`. Iz Ductusa samo e2e koji već provjeravaju uski zaslon.                                                                                                                                                                                                                                                                                                                                                                                                                                    | Faza D                                     |
| **web-other**                       | Ako ostaje (odluka 13): samo popravci kompatibilnosti i testovi preglednika. Iz Ductusa `.github/workflows/webkit-macos.yml` kao uzor za Safari.                                                                                                                                                                                                                                                                                                                                                                                                                                 | Faza D                                     |
| **desktop-windows / desktop-macos** | Ništa iz koda. Ljuska učitava isti web paket. Polazi od manifesta i simulacije preuzimanja (S-1H.5, S-1H.6) i ADR-a S-1E-e.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Faza E                                     |

**Ostaje samo u Ductusu, kao povijest:** `docs/` (odluke, Ustav, plan, sažeci), `STATE.md`, skripte orkestratora (`scripts/orchestrator`), alati za gate Ductusa dok Ductus živi, `spikes/`, `plugins/`, `.claude/` i `.agents/` Ductusa, `middleware.ts` i Next.js rute API-ja (zamjenjuju ih rute servera), stari vizualni snimci.

**Dvostruke promjene tijekom prijelaza (odluka vlasnika, Ductus#87 c.6881719844, točke 14 i 17):** od 14. 11. sav novi razvoj ide u Ducturu, a Ductus dobiva samo popravke; Ductus do 20. 12. ostaje funkcijski zaostao. Nova migracija glavne baze nastaje u `ductura/Institution_server` i kopira se u Ductus pod istim imenom i verzijom; CI provjerava jednakost `migrations.sum` u oba repoa do zamrzavanja Ductusa.

---

## 4. Redoslijed i faze (raniji plan A–E, povijest)

**Od 19. 11. 2026. vrijedi odjeljak „Pet faza”.** Tablica niže je raniji plan s fazama A–E i valovima 1–10; ostaje zbog poveznica iz ostalih dokumenata (V-1b, „Faza E · aktivacija desktop razvoja”). Odjeljci §4a do §4c pisani su za taj redoslijed. Proizvodna pravila iz njih (VS-1b kao uvjet za rad sa stvarnim podacima, R-1 do R-10) ostaju na snazi dok orkestrator i Daniel ne odluče drukčije.

| Faza                         | Što                                                                                                                                                | Ulaz                                                                                                     | Izlaz                                                                                                                                                         | Tvoje radnje                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **A** priprema, val 0        | Repo servera s CI-jem, gateom i botovima; prijenos temelja (S-0.1 … S-0.21)                                                                        | V-0, V-1                                                                                                 | Jedan pravi PR prošao cijeli gate u `Ductura/server`; ledger migracija jednak Ductusovu; skripte orkestratora vide repo                                       | V-0 domena i e-pošta; V-1 organizacija i repozitoriji; V-2 zaštita grane; V-3 botovi i Codex; V-4 tajne                           |
| **B** server, valovi 1–10    | Sve od S-1A do S-1I                                                                                                                                | Faza A gotova                                                                                            | Testni server objavljen kao Docker slika; S-1H.8 prolazi; `@ductura/contracts` objavljen u verziji 0.x                                                        | V-5 zahtjev Srcu; V-7 račun admina aplikacije                                                                                     |
| **C** preloader i web-chrome | Preloader (2.0), info stranica (2.1), web-chrome od komponenata; izdvajanje standarda (T-0); selidba `editor-core` u web-chrome po uvjetima iz §2d | VS-1 prošao; S-1M, S-1N, S-1H.7 i `@ductura/contracts` dostupni                                          | Prvi cijeli prolaz „domena → preloader → web-chrome → server” na sistemskom stogu; glavni tok u web-chromeu (otvori, piši, spremi, osvježi, bez veze, predaj) | V-1b (web i preloader, odobreno 14. 11., ne čeka fazu C); V-3 u njima; odluka o zamrzavanju Ductusa (ne prije 20. 12. 2026., §4d) |
| **D** web-mobile i web-other | Ista funkcija, druga sučelja                                                                                                                       | `@ductura/ui` i `@ductura/editor-core` u verziji 1.0; skup scenarija pariteta                            | Paritet zelen u sva tri weba; matrica preloadera zelena; domena prebačena na novi stog                                                                        | V-1b za ta dva repoa; potvrda prebacivanja produkcije                                                                             |
| **E** desktop                | Tanka ljuska oko istog web paketa za Windows i macOS                                                                                               | Odluka o ljusci i broju repozitorija (odluke 8 i 12); Apple račun; potpis za Windows; odgovor Srca (V-5) | Potpisani paketi; instalacija i pokretanje na čistom Windowsu i Macu; gumbi preloadera vode na prava izdanja                                                  | Apple Developer račun; certifikat za Windows; **Faza E · aktivacija desktop razvoja** (zasebna radnja, ne dio V-1b)               |

**Napomena o redoslijedu:** tvoje pravilo je „prvo server”. Predlažem dvije iznimke:

1. Čista logika preloadera (P-0.1, P-0.2). Ne treba server, mala je i dobro se testira tablicom. Radi se samo kad je pisac slobodan.
2. **Vertikalni presjek (VS-1, VS-2), prijedlog.**

### 4a. Vertikalni presjek (prijedlog)

Cilj: što ranije dokazati da sedam repozitorija stvarno radi zajedno, prije nego što izgradimo sve valove servera.

- **VS-1:** preloader + web-chrome + server. Korisnik se prijavi (lažni AAI@EduHr), otvori rad, spremi jednu rečenicu, osvježi stranicu i vidi rečenicu.
- **Ulaz VS-1:** od servera samo prijava i spremanje rada, ne svi valovi: S-1E-a (prijava), S-1D-d (kolačić i odjava), S-1M-a (zdravlje s verzijom) i uski rez servera (§4c; ranije S-M-5). **O-3 (Ductus#87 c.6880835493):** otvaranje, spremanje i ponavljanje evidencije dolaze iz uskog reza servera odmah iza S-0.19, ne čekaju valove 1 do 5 ni val 6. Od Ductusa: `@ductura/editor-core` 0.x (E-0.2).
- **Kriterij prihvata VS-1 (ispravak 14. 11.):** sintetički student se prijavi kroz lažni OIDC, spremi rečenicu i nakon osvježavanja stranice vidi tu rečenicu. Ovisi o DAN-758 (sheme i vektori za otvaranje i spremanje), DAN-759 (minimalni lokalni stog, umjesto S-1H.7) i DAN-760 (kriterij prihvata).
- **Izlaz VS-1:** test „prijava → otvori → spremi → osvježi” prolazi na sistemskom stogu, sa zapisanim SHA svakog repoa. Preloader i web-chrome imaju samo onoliko koda koliko presjek traži.
- **VS-1b (O-2):** zaseban, bezuvjetan nastavak VS-1; vidi §4a-1.
- **VS-2:** isti rad otvara se na mobitelu (web-mobile ili, ako je odluka 13 tako, web-chrome u mobilnom prikazu). Spremljena rečenica je ondje.
- Ostatak faza B i C nastavlja se nakon presjeka. Ako presjek pokaže da je razdvajanje preskupo, vidi se rano (prijedlog 17).

### 4a-1. Ovisnosti i prihvat VS-1 i VS-2 (Daniel 14. 11.)

Danielov tekst iz analize arhitekture, odobren za umetanje 14. 11. 2026. („Tekst za umetanje može”). Gdje se razlikuje od starijih redaka u §4a, vrijedi ovaj odjeljak.

**Ovisnosti do prvog spremljenog rada.** Za svaku rutu bilježimo tri odvojena prolaza. Nakon prihvaćene sheme klijent može graditi poziv i stanja sučelja. Nakon vektora uspjeha i grešaka te funkcionalnog lažnog servera može provjeriti ugovorno ponašanje. Nakon U10 integrira objavljenu verziju paketa. Sistemski prolaz izvodi se nad stvarnim handlerima, sesijom, trajnom bazom, objektnom pohranom i potpisnikom. DAN-758 određuje pozivatelja, handler i test za svaku rutu VS-1. Rani stog DAN-759 može se pripremati odmah, a njegov završetak čeka te handlere. Puni testni server S-1H.7 ostaje za kasniju provjeru pariteta.

**Prihvat VS-1 (izmjena prema O-2, Ductus#87 c.6880835493).** VS-1 se prihvaća s potpisom u istom odgovoru (protokol 1), **isključivo nad sintetičkim podacima u lokalnom i CI stogu**. U tom stogu sintetički student ulazi kroz `/`, prijavljuje se preko lokalnog OIDC pružatelja, vraća se u isti web pod `/app/` i otvara vlastiti postojeći rad s objavljenim `editor-coreom` 0.x. Upisuje jedinstvenu rečenicu. Nakon uspješnog lokalnog upisa editor prikazuje „Spremljeno na uređaju”. Odgovor servera nosi potpis u istom odgovoru; „Spremljeno na poslužitelju” prikazuje se tek kad klijent provjeri potpis za poslanu transakciju, dokument i reviziju. Nakon osvježavanja student vidi rečenicu. Čisti kontekst bez lokalnog dnevnika iz servera dobiva isti `documentId`, reviziju, hash i tekst. Test izgubljenog odgovora dokazuje da isti ključ i isti bajtovi daju jednu reviziju. Drugi student ne može pročitati ni izmijeniti taj rad. Uz prolaz se bilježe SHA preloadera, weba i servera, verzije paketa i rezultat provjera nad sintetičkim podacima.

Uz tvrdnje VS-1 (numeracija VS-1.x prema DAN-760) vrijede dvije dopune iz iste odluke:

- **VS-1.13 (nova tvrdnja):** nakon VS-1.7 proces servera (i radnika, ako postoji) gasi se i ponovno podiže, zatim se ponavlja VS-1.9. Isti dokument, ista revizija, isti hash i isti tekst moraju se vratiti iz trajne baze, ne iz memorije procesa.
- **Zabrana administratorske veze na bazu kao dokaza čitanja:** tvrdnje o čitanju (VS-1.9 i VS-1.13) dokazuju se kroz API servera kao student i kroz ulogu aplikacije s RLS-om. Čitanje preko administratorske ili vlasničke veze na bazu ne računa se kao dokaz.

**VS-1b (nova stavka, O-2).** Slijedi odmah nakon VS-1, **bezuvjetna je** i **uvjet je za osnovicu 20. 12. 2026. i za svaki rad sa stvarnim podacima (D-71)**. Sadržaj: odgovor `202 pending_signature`, worker koji potpisuje, red poslova, oporavak nakon prekida (worker, red i proces), te prikaz „Spremljeno na poslužitelju” tek nakon provjere potpisa. Protokol 1 nad stvarnim podacima nikad (D-71, R-1, §8a); prolaz VS-1b ne otvara protokol 1. VS-1b je `critical`, a ovisi o VS-1.

**Prihvat VS-2.** Isti student u novom mobilnom kontekstu kroz isti web otvara rad iz VS-1 i s poslužitelja dobiva istu potvrđenu reviziju i rečenicu. Rezultat navodi uređaj ili emulaciju i preglednički motor. Produkcijski AAI, objava desktop paketa i prijelaz postojećih studentskih radova imaju zasebne uvjete prihvata.

### 4b. Vremenska crta (procjena, NEPROVJERENO; raniji plan A–E, povijest)

Procjena vrijedi za raniji plan A–E. Za pet faza vrijede kontrolne točke 30. 11. i 15. 1. i proba 22. 2. 2027.

Migracija počinje onog dana kad postoji **V-1** (organizacija i repozitoriji). Dan 1 je prvi radni dan nakon toga.

Mjera su radni dani uz današnji tempo: oko 35–40 PR-ova dnevno preko svih pisaca. Novi repo u početku ide sporije od tog prosjeka. Razlozi su ograničenje od tri kodna PR-a po repou, migracije redom, `critical` gate i ovisnosti među zadacima. Vanjska čekanja (Srce, Apple, certifikat za Windows, tvoje odluke) nisu uračunata.

| Faza                       | Procjena (radni dani)     | Okvirno od–do                                 | Napomena                                                                                                                                   |
| -------------------------- | ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A (val 0)                  | 3–6                       | dan 1 – dan 6                                 | NEPROVJERENO. Gate se tek postavlja, pa su prvi PR-ovi sporiji.                                                                            |
| B (valovi 1–10)            | 8–15                      | dan 4 – dan 20                                | NEPROVJERENO. Oko 95 zadataka; usporedni rad počinje u valu 5.                                                                             |
| Uski rez servera (O-3)     | prema PR-ovima            | od završetka S-0.19, usporedno s valovima 1–5 | NEPROVJERENO. Zasebni `critical` PR-ovi redom (§4c). Nije izdanje.                                                                         |
| VS-1 i VS-2                | 2–4                       | otprilike dan 10 – dan 16                     | NEPROVJERENO. Kreće čim su gotovi S-1E-a, S-1D-d, S-1M-a i uski rez (§4c; ranije S-M-5), usred faze B. VS-1 samo nad sintetičkim podacima. |
| VS-1b                      | nakon VS-1                | prije osnovice 20. 12. 2026.                  | Bezuvjetan (O-2). Uvjet za osnovicu 20. 12. i za rad sa stvarnim podacima.                                                                 |
| C (preloader i web-chrome) | 10–20                     | dan 14 – dan 35                               | NEPROVJERENO. Najveći dio prijenosa sučelja; preklapa se s krajem faze B.                                                                  |
| D (mobile i other)         | 5–10                      | dan 30 – dan 45                               | NEPROVJERENO. Kraće ako je `web-other` tanak ili ga nema (odluka 13).                                                                      |
| E (desktop)                | 8–15                      | dan 40 – dan 60                               | NEPROVJERENO. Plus vanjska čekanja na Apple račun, certifikat i Srce.                                                                      |
| **Ukupno**                 | **oko 35–60 radnih dana** |                                               | NEPROVJERENO. Prva provjera procjene nakon faze A, iz mjera M-0.1.                                                                         |

**Prezentacija 16. 11.** radi na Ductusu. Ništa iz ovog plana ne dira kod Ductusa prije toga, osim dokumenata (S-0.1, S-0.2) i spikea (S-0.3).

### 4c. Uski rez servera za VS-1 (O-3)

Odluka vlasnika (Ductus#87 c.6880835493, točka 3; mijenja D-306 t. 15; stari unos ostaje u povijesti).

- **Što:** sesija, `open`, `commit` i `replay` grade se **odmah iza S-0.19**, usporedno s valovima 1 do 5.
- **Kako:** svaki dio je zaseban `critical` PR, redom, **bez ugniježđenih PR-ova**; nad pravim PostgreSQL-om s RLS-om i pgTAP-om; u mapama područja iz server `docs/PLAN.md` §3.
- **Uvjet početka:** S-0.19 spojen; prije svakog dijela plan napada (`ductus-attack-plan`); stalna granica od tri kodna PR-a po repou vrijedi i za rez.
- **Rez nije izdanje.** Valovi 1 do 5 ostaju uvjet za pilot. Rez služi samo da VS-1 (i VS-1b) ne čekaju sve valove.
- Novi D-unos koji navodi što mijenja (D-306 t. 15) i izmjena server `docs/PLAN.md` idu zasebnim docs PR-ovima kroz gate; ovaj dokument samo bilježi odluku.

### 4d. Pilot na jednom sustavu (O-1)

Odluka vlasnika (Ductus#87 c.6880835493, točka 1). Ovdje su „faze A i B pilota” faze pilota, ne faze migracije A–E iz §4.

- Faze A i B pilota rade na **jednom sustavu**. Bira ga vlasnik prije faze A pilota, **na kontrolnoj točki 20. 12. 2026.**, uz mjerenje osnovice M3 na sustavu koji ide u pilot.
- **Do izbora Ductus ostaje spreman za pilot; zamrzavanje iz D-295 ne nastupa prije izbora.** Ovo ima prednost pred „zamrzavanjem” u §8 točka 4 i §9 redak 10.
- Proba povrata (M11.2-P04) ostaje GO uvjet prije stvarnih studenata (R-8).

---

## 5. Standard svakog repozitorija

Isti za svih sedam. Razlike su samo u putanjama i vrstama testova.

| Stavka                                     | Pravilo                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grana `main`                               | PR obvezan, squash, bez izravnog pusha, obvezna zbirna provjera `ci-ok` i statusi gatea. Postavljaš ti (V-2).                                                                                                                                                                                                                                                                                     |
| CI                                         | Lint, typecheck, **funkcionalni testovi** i **testovi pomoćnih funkcija** kao odvojeni poslovi; skeniranje tajni; pregled ovisnosti; `ci-ok` pada ako padne bilo koji potreban posao. Akcije prikvačene na SHA.                                                                                                                                                                                   |
| Funkcionalni test                          | Onaj iz tvoje tablice, npr. server „vlastiti dokument da, tuđi ne” (S-1H.3), preloader „Chrome na Macu otvara Chrome i nudi macOS paket”.                                                                                                                                                                                                                                                         |
| Test pomoćnih funkcija                     | Unit testovi uz kod, npr. server „prazan i neispravan ID”, mobile „izračun prostora uz tipkovnicu”.                                                                                                                                                                                                                                                                                               |
| Gate                                       | Isti kao Ductus: risk razine po putanjama, `Agent-Review:` i `QA-Agent:` na aktualnom headu, Codex review na točnom headu, dvije različite aplikacije za `critical`; spajanje po pravilu iz §7. **Za migraciju (faze 1–4) ne vrijedi:** vrata su opisana u odjeljku „Pet faza” (faza 2: lokalni test orkestratora; faza 4: zeleni CI i jedan ciljani pregled kritičnih dijelova po repozitoriju). |
| CODEOWNERS                                 | Pokriva sve `critical` putanje.                                                                                                                                                                                                                                                                                                                                                                   |
| `CLAUDE.md`, `AGENTS.md`, `.claude/rules/` | Tanki adapteri. Nijedno novo pravilo. Upućuju na kanonske dokumente.                                                                                                                                                                                                                                                                                                                              |
| README                                     | Na hrvatskom: što repo radi, kako se pokreće, kako se testira, što nikad ne sadrži.                                                                                                                                                                                                                                                                                                               |
| Pravilnik koda                             | Jedan `docs/CODE_STYLE.md` (S-0.5), isti u svim web i serverskom repou. Desktop dobiva dodatak za svoj jezik.                                                                                                                                                                                                                                                                                     |
| Izdanja                                    | Semantička verzija i oznaka `vX.Y.Z`. Server: Docker slika i paket ugovora. Web: statična izgradnja. Desktop: potpisani paket u GitHub Releaseu.                                                                                                                                                                                                                                                  |
| Botovi                                     | Ista labela i ista pravila kao u Ductusu (`ready-for-claude`, `bug`, `security`, `area:*`, `role:*`).                                                                                                                                                                                                                                                                                             |

Web repozitoriji koriste Next.js sa statičnom izgradnjom (`output: 'export'`), bez server actions i bez vlastitih ruta API-ja. Tako ostaje postojeći kod, a server ostaje jedini server. Preloader ima proračun veličine (test pada ako JavaScript prvog ekrana prijeđe dogovorenu granicu).

---

## 6. Testiranje preko repozitorija

| Vrsta                      | Što provjerava                                                                                                                                                                          | Gdje živi                                                                                                                       | Tko pokreće                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ugovorni testovi**       | Klijent i server govore isti jezik. Klijent prikvači verziju `@ductura/contracts` i pokreće njezine vektore. Server pokreće vektore svih glavnih verzija koje još podržava.             | Vektori u serveru (S-1H.4); provjera u CI-ju svakog klijenta                                                                    | CI na svakom PR-u                                                                                                                                  |
| **Scenariji pariteta**     | Isti tok prolazi u sva tri weba: prijava, otvaranje rada, pisanje, rad bez veze, ponovno spajanje, predaja.                                                                             | Razina API-ja u serveru (S-1H.8). Razina sučelja kao paket `@ductura/parity` u web-chromeu, koji pokreću web-mobile i web-other | CI svakog weba, nad Docker slikom testnog servera (S-1H.7)                                                                                         |
| **Matrica preloadera**     | Dvije odluke zasebno: sučelje po uređaju i pregledniku, gumb po sustavu. Rubni slučajevi: Edge s oznakom Chrome, iPad u desktop načinu, uski prozor, nepoznat sustav, nedostupan paket. | `preloader`: tablični unit test (P-0.2) i Playwright s emuliranim uređajima u Chromiumu, Firefoxu i WebKitu (P-0.11)            | CI preloadera                                                                                                                                      |
| **Simulacija preuzimanja** | Pravi paket za svaki sustav i arhitekturu, SHA-256 se poklapa, preuzimanje samo na klik.                                                                                                | Server (S-1H.6); kasnije desktop repo s pravim paketom                                                                          | CI servera; CI desktopa pri izdanju                                                                                                                |
| **Sistemski e2e**          | „Domena → preloader → sučelje → server” kroz pravi proxy.                                                                                                                               | `preloader/e2e/system/` i `deploy/edge/` (proxy). Stog: slika testnog servera + statične izgradnje sva tri weba + preloader.    | Noćni posao u preloaderu i svaki kandidat za izdanje. QA sesija čita rezultat; orkestrator ga ne smatra prolazom bez zapisa SHA-ova svih dijelova. |

Svaki prolaz bilježi verziju sustava, preglednika ili paketa i točan SHA svakog sudjelujućeg repoa. Svi podaci su izmišljeni.

Pravi uređaji (iPhone, iPad, Android) za fazu D: Playwright emulacija ne zamjenjuje pravi uređaj za zaslonsku tipkovnicu. Predlažem ručni QA protokol na tvojim uređajima ili plaćenu farmu uređaja (odluka 9).

---

## 7. Gate, botovi i orkestracija na sedam repozitorija

**Gate (raniji plan; za migraciju vrijede vrata iz odjeljka „Pet faza”: bez reviewa i QA-a po PR-u u fazama 2 i 4).** Workflow gatea i skripte (`risk-floor`, provjera verdikata) pišu se u `.github` (S-0.10-a/b, T-0.2), ne u serveru. Svaki repo ih poziva punim SHA-om `.github` repoa (`@<40 znakova> # gate-v1`; oznaka je samo komentar, nikad sam poziv, kako traži `README.md` tog repoa) i daje samo svoju tablicu putanja za risk. Retci verdikta ostaju isti (`Agent-Review:`, `Review-Head:`, `Review-Verdict:`, `QA-*`), a format agenta ostaje `runtime:slot:role`.

**Redoslijed V-2 i obveznih statusa (ispravak 14. 11.):** S-0.9 (u serveru) i S-0.10-b (u `.github`, pozvan iz servera) prvo dokažu prolaz i očekivani pad svakog posla; zatim V-2 dopisuje točna emitirana imena u obvezne statuse. Postojeća zaštita (`test`) ostaje dok se u serveru ne dokaže prolaz i očekivani pad.

**U11, gate prema riziku uz ugovorne testove (ispravak 14. 11.):** zadnji korak, nakon U10 i S-1H.8. Ide kao zaseban PR pravila, a vlasnik mora potvrditi tekst pravila prije spajanja.

**Spajanje (odluka 17. 11.):** nadzor (glavni orkestrator, §7a) spaja PR nakon punog gatea (`--squash --match-head-commit`), u svakom repou jedan po krugu; dok je CI na mainu crven ili nečitljiv, u tom repou ne spaja. PR-ove koji po D-97 traže tvoju naredbu i dalje spaja samo tvoja naredba; ostale odluke ostaju iste. Mergify je ukinut 17. 11. (Daniel, „Da za oboje”), a s njim T-0.3 i S-0.20. Uvjet povratka: Mergify se vraća ako dva PR-a zaredom slome main ili ako spajanje mora raditi bez ovog računala.

**Botovi (`ductus-botovi[bot]`).** Danas je aplikacija instalirana samo na Ductus, a pravilo u `CLAUDE.md` to i kaže. Aplikacija u vlasništvu osobnog računa ne može se instalirati na tuđu organizaciju dok je privatna. Prijedlog: prenesi aplikaciju u organizaciju `Ductura` (GitHub to dopušta) i instaliraj je na odabrane repozitorije. Pravilo o „samo ovom repou” mijenja se D-zapisom, kao promjena pravila. Grok strani treba popis repozitorija koje čita.

**Codex i druga aplikacija za `critical`.** Instaliraju se na svaki aktivni repo. Kvota Codexa dijeli se na više repozitorija; pravilo „prvo potvrda, pa novi zahtjev” ostaje.

**Skripte orkestratora.** S-0.21 dodaje parametar `--repo`. T-0.6 to širi: jedan popis praćenih repozitorija, `orch:overlap` i preko repozitorija (npr. promjena ugovora u serveru i PR u webu koji ga koristi), status gatea za sve. Nadzor i heartbeat izvan repoa usklađujem sam.

**Ograničenje WIP-a.** Danas: najviše tri kodna PR-a izvan nacrta. Prijedlog: tri po repozitoriju, uz ukupnu granicu pisaca zbog RAM-a i oblaka (odluka 7).

**Koordinacijski issue.** Prijedlog: **#87 u Ductusu ostaje jedino mjesto tvojih odluka za sve repozitorije.** Tako povijest odluka ostaje na jednom mjestu. Svaki novi repo ima:

- issue „Koordinacija <repo>” za bilješke orkestratora tog repoa,
- issue „Botovi: dnevni pregled” za botove.

**Kanonski dokumenti.** `docs/ENGINEERING_SYSTEM.md`, `DECISIONS.md` i Ustav ostaju u Ductusu. Novi repozitoriji ih navode poveznicom (S-0.6). Kad se Ductus zaključa, ostaju čitljivi.

**Linear (prijedlog).** Ostaje **jedan projekt „Ductus”**, uz labelu po repozitoriju (`repo:server`, `repo:preloader` …) i prekretnice po fazama A–E. Za funkciju koja dira više repozitorija postoji **jedan zajednički zadatak** s poveznicama na svaki PR u svakom repou. Pod-zadaci po repou samo ako je posao velik. Integracija Lineara s GitHubom spaja se i na organizaciju `Ductura`, pa `DAN-xxx` radi u svim repozitorijima. Pravilo „svaki PR veže DAN-xxx” ostaje.

### 7a. Orkestratori po repozitoriju

Pitanje: može li svaki repo imati svog orkestratora, pa da svih sedam radi usporedno? **Preporuka: ne odmah. Jedan glavni orkestrator, a orkestratori po području dodaju se u etapama**, tek kad njihovi repozitoriji imaju stvaran usporedni posao.

**Glavni orkestrator** posjeduje sve što prelazi granice repozitorija:

- verzije ugovora (`@ductura/contracts`) i zajedničkih paketa (`editor-core`, `ui`);
- izdanja i sistemski e2e;
- #87, Linear i zajedničke zadatke;
- spajanja koja traže tvoju naredbu (D-97).

**Etape:**

| Etapa | Orkestratori                                                                             | Kada počinje                           |
| ----- | ---------------------------------------------------------------------------------------- | -------------------------------------- |
| 1     | Samo glavni, radi na serveru                                                             | Od V-1                                 |
| 2     | Glavni (server) + **front orkestrator** za preloader, web-chrome, web-mobile i web-other | Zajedno s vertikalnim presjekom (VS-1) |
| 3     | + **desktop orkestrator**                                                                | Kad počne rad na ljusci (faza E)       |

Najviše **tri** orkestratora u isto vrijeme.

**Zašto ne sedam odmah:**

1. **RAM.** Desktop ima 16 GB, a orkestrator je već padao zbog manjka memorije. Dodatni orkestratori rade u oblaku ili na laptopu, ne na desktopu.
2. **Kvota.** Svaki orkestrator troši kvotu jednako kao pisac, i to stalno.
3. **Ti si jedna točka odluke.** Sedam orkestratora značilo bi sedam redova pitanja za tebe.
4. **Ovisnosti.** Na početku svi repozitoriji čekaju ugovor servera i paket editora. Sedam usporednih orkestratora uglavnom bi čekalo.

**Pravila:**

- Svaki orkestrator ima svoje ime slota (npr. `claude:b:orchestrator`, `claude:c:orch-front`) i svoj koordinacijski issue u svakom svom repou.
- Samo glavni mijenja zajedničke pakete i verzije ugovora. Front ili desktop orkestrator za to otvara zahtjev glavnom.
- Bazen pisaca i ograničenja WIP-a dijele se među orkestratorima. Glavni objavljuje podjelu na #87, a mijenja je samo on.
- **Prvo mjeri, pa dodaj.** Novi orkestrator dolazi tek kad mjere iz prijedloga 17 pokažu da postojeći ne stiže (npr. PR-ovi gotovi za review čekaju dulje od dogovorenog).

---

## 8. Rizici i moji prijedlozi

1. **Sedam repozitorija, jedan vlasnik: više održavanja.** Prijedlog: jedan pomoćni repo `Ductura/.github`, koji nije razvojni dio i nema koda aplikacije. U njemu su zajednički workflowi, predlošci issuea i PR-a, popis labela i profil organizacije. GitHub taj repo posebno prepoznaje. Ako ne želiš ni njega, sve to ide u `Ductura/server` (odluka 3).
2. **Razilaženje postavki među repozitorijima.** Prijedlog: tjedna provjera (T-0.7) koja samo čita: zaštita grane, obvezni statusi, instalirane aplikacije, labele. Nalaz ide u koordinacijski issue.
3. **Novi repo bez standarda.** Prijedlog: generator početnih datoteka (T-0.4). Novi repo dobiva README, adaptere pravila, CODEOWNERS, predložak PR-a, risk tablicu i labele u jednom PR-u.
4. **Ductus i novi repozitoriji paralelno.** Rizik: dvostruke promjene i dvije istine. Prijedlog u tri koraka:
   - sada: Ductus dovršava PR-ove u gateu, od 14. 11. sav novi razvoj ide u Ducturu, a Ductus dobiva samo popravke (odluka vlasnika, Ductus#87 c.6881719844, točka 14);
   - **zamrzavanje** kad web-chrome prođe glavni tok na novom serveru (kraj faze C): Ductus dobiva samo sigurnosne popravke. **Ne prije izbora sustava za pilot 20. 12. 2026. (O-1, §4d; D-295);**
   - **zaključavanje samo za čitanje** dva tjedna nakon prebacivanja domene (kraj faze D).
5. **Desktop: tanka ljuska, nikad novi editor.** Izvorni editor u C#-u ili Swiftu bio bi četvrti i peti editor, uz web-chrome, mobile i other. To je najveći mogući trošak i rizik plana. Prijedlog: desktop je tanka izvorna ljuska oko **istog web paketa**. Ljuska radi prozor, instalaciju, ažuriranje, prijavu tokom (S-1E-e) i lokalno spremište. Tri moguća puta:
   - **A:** Windows u C#/.NET s WebView2 (motor Chromium), macOS u Swiftu s WKWebView (motor WebKit). Dva repozitorija, kako si zadao.
   - **B:** jedan kod za oba sustava, Tauri ili Electron. Tada predlažem **jedan repo `desktop` s dva cilja** (Windows i macOS) umjesto dva repozitorija.
   - **C:** mješovito nije preporučeno.
     Moja preporuka: A ako želiš izvorni osjećaj i C# kako je predloženo; B ako želiš manje održavanja. Odluka najkasnije na kraju faze C, uz kratki spike (D-0.1) ranije (odluke 8 i 12).
6. **macOS potpis i notarizacija.** Bez Apple Developer računa (99 USD godišnje) macOS blokira aplikaciju. Račun treba prije prvog javnog paketa. Predlažem otvoriti ga na početku faze E, ne prije.
7. **Windows potpis.** Bez potpisa SmartScreen upozorava korisnika. Mogućnosti: klasični certifikat (oko 200 do 400 USD godišnje) ili Microsoftova usluga potpisa u oblaku (mjesečna pretplata; treba provjeriti dostupnost za Hrvatsku). Odluka u fazi E.
8. **Gdje žive paketi za preuzimanje.** Prijedlog: izvor istine je GitHub Release desktop repoa. Server u manifestu drži adresu i SHA-256. Za korisnika ostaje jedna domena: `/preuzimanje/` vodi kroz server. Na početku je to preusmjeravanje na Release; kasnije, ako ustanova traži, kopija u vlastitoj pohrani.
9. **Token za pakete u oblaku.** Sesije u oblaku već imaju probleme s GitHub tokenom, a GitHub Packages traži token za čitanje. Registar je GitHub Packages (ispravak 14. 11., §2c); rizik se ublažava tokenom `GITHUB_TOKEN` u CI-ju.
10. **Lomljenje ugovora.** Promjena API-ja može srušiti sva četiri klijenta odjednom. Prijedlog: zaštita od lomljenja u serveru (S-1H.1-b), vektori starih verzija u CI-ju servera i Dependabot PR u klijentima kao rano upozorenje.
11. **Proxy kao jedna točka kvara.** Konfiguracija proxyja ima svoje testove u preloaderu (svaka putanja vodi na pravi dio, nepoznata putanja na stranicu greške).
12. **Kvota Codexa i botova.** Više repozitorija znači više reviewa. Prijedlog: Codex samo za `standard` i `critical`, a `low` PR-ovi samo uz Claude review, kao danas.
13. **RAM i lokalni rad.** Sedam repozitorija znači više worktreeja i ovisnosti. Prijedlog: pisci rade u oblaku, lokalno najviše tri, kao danas. Sistemski e2e ide samo u CI-ju.
14. **Javni repozitoriji.** Ductus je javan, pa će biti i novi. Prednost: besplatni GitHub runneri, i za macOS. Pazi: nalazi sigurnosti i dalje samo privatno (nacrti savjeta), nikad u javni issue.
15. **Više kopija editora i sinkronizacije.** Prijedlog: jedna implementacija, paket `@ductura/editor-core` (§2d). Počinje u Ductusu, seli se u web-chrome tek po četiri uvjeta izlaza. Nijedan drugi repo ne smije imati vlastiti editor ili dnevnik; T-0.7 to provjerava (traži uvoz Tiptapa ili Dexieja izvan paketa).
16. **Treba li `web-other` uopće vlastito sučelje?** Moderni Firefox, Safari, Edge i Opera izvode isti kod kao Chrome. Zaseban frontend značio bi treću kopiju ekrana bez stvarne potrebe. Prijedlog: **web-chrome postaje sučelje za sve preglednike na računalu**, uz CI s matricom preglednika (Chromium, Firefox, WebKit) i male popravke kompatibilnosti u `src/platform`. Preloader tada za ostale preglednike otvara isto sučelje. Druga mogućnost: `web-other` ostaje kao **tanki repo za kompatibilnost i testove** (popravci za Safari i Firefox, matrica preglednika, bez vlastitih ekrana). Time i dalje imaš sedam repozitorija. Odluka 13.
17. **Cijena razdvajanja se ne vidi na vrijeme.** Prijedlog: mjeriti od prvih zadataka (M-0.1, dodatak u `orch:metrics`):
    - koliko repozitorija dira jedna promjena;
    - koliko PR čeka na PR u drugom repou;
    - vrijeme od prvog commita do testiranog izdanja, uz ostale DORA mjere (učestalost izdanja, udio promjena koje ruše, vrijeme oporavka).
      **Pravilo:** ako obične promjene stalno traže tri gotovo jednaka PR-a (npr. ista izmjena u tri weba), to je znak da treba dijeliti više koda. Tada predlažem premještanje tog dijela u paket. Mjere idu u tjedni izvještaj petkom.
18. **Krivo prepoznavanje u preloaderu.** Niz preglednika (UA) laže: Edge i Opera nose oznaku Chrome, iPad se predstavlja kao Mac. Prijedlog: prepoznavanje koristi **client hints** (`Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform`) i **provjeru mogućnosti** (dodir, širina zaslona, podržani API-ji), a niz preglednika samo kao zadnju zamjenu. Nikad samo niz. Korisnik **uvijek** može ručno promijeniti prikaz i paket. Prepoznavanje ne služi za ovlasti i nije otisak preglednika (3c).

---

## 8a. Rizici

Rizici uz odluku vlasnika 14. 11. (Ductus#87 c.6880835493). Svaki ima jednog nositelja zapisa u planu; pojedinosti i rok potvrđuje orkestrator u zadatku.

| ID   | Rizik                                                                                                              | Što se traži                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | Protokol 1 (potpis u istom odgovoru) ne smije nikad dotaknuti stvarne podatke.                                     | Samo sintetički podaci u lokalnom i CI stogu (D-71). VS-1b je uvjet za svaki rad sa stvarnim podacima (§4a-1).                                                                                                                                                                                                                   |
| R-2  | Lokalni zapis (dnevnik) u pregledniku.                                                                             | Šifriranje ili rok trajanja lokalnog zapisa odlučen prije pilota (D-122); shema dnevnika u E-0.1.                                                                                                                                                                                                                                |
| R-3  | Izmjene izdanja tijekom pilota.                                                                                    | Faza A pilota zamrzava izdanje (§4d).                                                                                                                                                                                                                                                                                            |
| R-4  | Domena je vezana uz AAI registraciju i `__Host-` kolačić (§1c).                                                    | V-0 mora biti konačan prije zahtjeva Srcu (V-5).                                                                                                                                                                                                                                                                                 |
| R-5  | Knjiga migracija (ledger).                                                                                         | Samo za dodavanje (append-only). S-0.13 prenosi 112 migracija i `migrations.sum` doslovno u `db/main/migrations/`, s istom knjigom (usklađeno s §4, §10 i serverskim planom, `ductura/Institution_server` docs/PLAN.md redak 61). Nove migracije vidi §3 (točka 17).                                                             |
| R-6  | Domena evidencije i registar ključeva.                                                                             | Dolaze iz konfiguracije operatera (D-102, DAN-759), ne iz koda.                                                                                                                                                                                                                                                                  |
| R-7  | Sintetički prolaz na stagingu.                                                                                     | Ovisi o B0.1.                                                                                                                                                                                                                                                                                                                    |
| R-8  | Proba povrata baze nikad nije izvršena.                                                                            | Proba (M11.2-P04) mora uključiti nižu reviziju na poslužitelju nakon povrata. Odluka vlasnika (Ductus#87 c.6880906459, varijanta A): na nižoj reviziji nakon povrata klijent ponovno šalje lokalne korake kao nove revizije s novim potpisanim potvrdama; lanac dokaza nosi oznaku „obnovljeno iz lokalne kopije nakon povrata”. |
| R-9  | Inventar v1.                                                                                                       | Potvrda inventara; izbor po `receiptSchema`.                                                                                                                                                                                                                                                                                     |
| R-10 | Dva statusa spremanja („Spremljeno na uređaju”, „Spremljeno na poslužitelju”) nasuprot osam stanja sinkronizacije. | Preslikavanje između dva statusa i osam stanja mora biti zapisano i testirano prije nego se „Spremljeno na poslužitelju” prikaže (kroz VS-1 i VS-1b).                                                                                                                                                                            |

---

## 9. Odluke koje trebam od tebe

| #   | Pitanje                              | Moja preporuka                                                                                                                                                                                                                 |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Usmjeravanje na domeni               | Jedna adresa i podputanje (`/`, `/c/`, `/m/`, `/o/`, `/api/v1/`)                                                                                                                                                               |
| 2   | Način dijeljenja koda i registar     | Verzionirani paketi; registar GitHub Packages (odluka od 14. 11., ispravak). Javni npm opseg bio je raniji prijedlog.                                                                                                          |
| 3   | Pomoćni repo za zajedničke workflowe | `Ductura/.github`, bez koda aplikacije. Alternativa: sve u serveru.                                                                                                                                                            |
| 4   | Gdje se bilježe tvoje odluke         | #87 u Ductusu ostaje jedino mjesto za svih sedam repozitorija                                                                                                                                                                  |
| 5   | Linear                               | Jedan projekt „Ductus”, labela po repou, jedan zajednički zadatak po funkciji s poveznicama na sve PR-ove, prekretnice po fazama                                                                                               |
| 6   | Aplikacija botova                    | Prenijeti `ductus-botovi` u organizaciju; promijeniti pravilo „samo ovaj repo” D-zapisom                                                                                                                                       |
| 7   | WIP                                  | Tri kodna PR-a po repozitoriju, uz ukupnu granicu pisaca                                                                                                                                                                       |
| 8   | Desktop ljuska i trenutak            | Tanka ljuska oko istog web paketa, nikad izvorni editor. Put A (C#/.NET + WebView2 i Swift + WKWebView) ili put B (Tauri ili Electron). Odluka najkasnije na kraju faze C, spike ranije.                                       |
| 9   | Pravi mobilni uređaji                | Ručni QA protokol na tvojim uređajima; farma uređaja tek ako se pokaže potreba                                                                                                                                                 |
| 10  | Zamrzavanje Ductusa                  | Zamrznuti na kraju faze C, zaključati dva tjedna nakon prebacivanja domene. **Dopuna O-1:** ne prije izbora sustava za pilot 20. 12. 2026. (§4d)                                                                               |
| 11  | Repozitoriji pri V-1                 | Otvoriti svih sedam odmah (rezervacija imena), aktivirati samo `server`; ostali prazni s README-om „u pripremi”                                                                                                                |
| 12  | Jedan ili dva desktop repozitorija   | Dva (`desktop-windows`, `desktop-macos`) uz put A; jedan `desktop` s dva cilja uz put B                                                                                                                                        |
| 13  | `web-other`                          | Web-chrome za sve preglednike na računalu uz matricu preglednika u CI-ju; `web-other` kao tanki repo za kompatibilnost i testove ako želiš zadržati sedam repozitorija                                                         |
| 14  | Editor i sinkronizacija              | Jedan paket `@ductura/editor-core`: počinje u Ductusu, seli se u web-chrome po uvjetima iz §2d                                                                                                                                 |
| 15  | Vertikalni presjek                   | Da: VS-1 odmah nakon S-1E-a, S-1D-d, S-1M-a i uskog reza servera (§4c; ranije S-M-5, više nije ulaz VS-1). **Dopuna O-2, O-3:** VS-1 samo nad sintetičkim podacima, VS-1b bezuvjetan; uski rez servera iza S-0.19 (§4a-1, §4c) |
| 16  | Mjere razdvajanja                    | Da: M-0.1 u `orch:metrics` od prvih zadataka, s pravilom „tri gotovo jednaka PR-a → dijeli više”                                                                                                                               |
| 17  | Orkestratori po repozitoriju         | Ne sedam odmah: glavni + front (od VS-1) + desktop (od faze E), najviše tri, dodatni u oblaku ili na laptopu (§7a)                                                                                                             |
| 18  | Pilot na jednom sustavu (O-1)        | Odlučeno 14. 11.: izbor na kontrolnoj točki 20. 12. 2026. (§4d)                                                                                                                                                                |

---

## 10. Prva dva tjedna (raniji plan, povijest)

Raspored niže pisan je za raniji plan A–E. Za pet faza vidi odjeljak „Pet faza”.

Pretpostavka: početak u ponedjeljak 17. 11., nakon prezentacije. Dokumenti i spike mogu i ranije.

### 10a. Što se mijenja u postojećim zadacima

| Zadatak            | Izmjena                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-0.1              | D-zapis navodi `preloader` kao sedmi repo umjesto `shared-core`. Dodaje odluke iz §9 koje potvrdiš (usmjeravanje, paketi, pomoćni repo, botovi).                                                    |
| S-0.6              | Adapteri pravila nastaju tako da ih T-0.4 kasnije može kopirati u druge repozitorije. Sadržaj isti.                                                                                                 |
| S-0.9              | Gradi se u serveru kao danas. Piše se tako da ga T-0.2 kasnije izdvoji bez promjene ponašanja.                                                                                                      |
| S-0.20             | **Ukinuto 17. 11.** Spajanje ide po pravilu iz §7.                                                                                                                                                  |
| S-0.10-a, S-0.10-b | Pišu se u `.github` (kao T-0.2), ne u serveru; server ih poziva punim SHA-om.                                                                                                                       |
| S-0.11             | Ovisi i o prijenosu aplikacije botova u organizaciju (V-3). Labele dolaze iz zajedničkog popisa kad postoji T-0.1.                                                                                  |
| S-0.19             | Briše se „Otvoreno: prelazi u shared-core”. `server/domain` ostaje u serveru i objavljuje se u `@ductura/contracts`. Time je pitanje shared-corea zatvoreno (zamijenjeno paketima, KARTA §4).       |
| S-0.21             | Popis praćenih repozitorija ima svih sedam plus Ductus. Proširenje preko repozitorija je T-0.6.                                                                                                     |
| S-1L.1             | Briše se „dugoročno mjesto lokala je shared-core”. Serverske lokale ostaju u serveru. Lokale sučelja idu u `@ductura/ui`. Test u `@ductura/ui` provjerava da svaki kod greške iz ugovora ima tekst. |
| S-1M-c             | Katalog grešaka objavljuje se u `@ductura/contracts`, jer ga preloader treba.                                                                                                                       |
| S-1H.4, S-1H.8     | Vektori i scenariji objavljuju se u `@ductura/contracts`. Potrošači su preloader i web repozitoriji, ne shared-core.                                                                                |
| §6 i §7 popisa     | „Testovi shared-core” zamjenjuju testovi preloadera. Desktop gradi nad paketima i OpenAPI-jem, ne nad shared-coreom.                                                                                |

### 10b. Novi zadaci

| ID       | Što                                                                                                                                           | Repo                          | Ovisi o                                                       | Risk     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- | -------- |
| T-0.1    | Pomoćni repo: profil organizacije, predlošci issuea i PR-a, zajednički popis labela                                                           | `.github` (ili server)        | V-1, odluka 3                                                 | standard |
| T-0.2    | Zajednički workflowi: CI osnova s `ci-ok`, gate, tajne, ovisnosti; S-0.10-a/b se pišu ovdje, ne u serveru                                     | `.github`                     | U2, S-0.9                                                     | critical |
| T-0.3    | **Ukinuto 17. 11.** (bila su zajednička pravila spajanja; spajanje ide po pravilu iz §7)                                                      | `.github`                     | —                                                             | —        |
| T-0.4    | Generator početnih datoteka novog repoa                                                                                                       | `.github`                     | S-0.6, T-0.2 (uključuje S-0.10-a)                             | standard |
| T-0.5    | Objava paketa: verzije, zapisi promjena, objava iz Actionsa                                                                                   | server                        | S-1H.1-b, odluka 2                                            | critical |
| T-0.6    | Skripte orkestratora za sedam repozitorija, preklapanje preko repozitorija                                                                    | Ductus                        | S-0.21                                                        | critical |
| T-0.7    | Tjedna provjera razilaženja postavki (samo čitanje)                                                                                           | `.github`                     | T-0.2                                                         | standard |
| P-0.1    | Kostur preloadera (statična izgradnja, proračun veličine)                                                                                     | preloader                     | V-1b, T-0.4 ili ručno                                         | standard |
| P-0.2    | Dvije odluke kao čiste funkcije, s tablicom iz plana prvog vala; ulaz su client hints i provjera mogućnosti, niz preglednika samo kao zamjena | preloader                     | P-0.1                                                         | standard |
| P-0.3    | Ručni izbor prikaza i paketa, pamćenje izbora                                                                                                 | preloader                     | P-0.2                                                         | standard |
| P-0.4    | Provjera servera i verzije API-ja                                                                                                             | preloader                     | S-1M-a                                                        | standard |
| P-0.5    | Stranice grešaka iz kataloga                                                                                                                  | preloader                     | S-1M-c                                                        | standard |
| P-0.6    | Traka kolačića i ekran pristanka                                                                                                              | preloader                     | S-1N-d                                                        | critical |
| P-0.7    | Ulaz u prijavu AAI@EduHr; FIDO2 za mrežnog inženjera                                                                                          | preloader                     | S-1E-a, S-1E-g                                                | critical |
| P-0.8    | Slanje konteksta klijenta                                                                                                                     | preloader                     | S-1M-b                                                        | standard |
| P-0.9    | Info stranica, javni pravni tekstovi, stranica za preuzimanje                                                                                 | preloader                     | S-1N-c, S-1H.5                                                | standard |
| P-0.10   | Proxy na domeni i lokalni sistemski stog                                                                                                      | preloader                     | S-1H.7                                                        | critical |
| P-0.11   | Matrica preloadera u Playwrightu (tri motora)                                                                                                 | preloader                     | P-0.3                                                         | standard |
| D-0.1    | Spike desktop ljuske (WebView2, WKWebView, Tauri) s istom web izgradnjom                                                                      | Ductus `spikes/`              | kraj faze B                                                   | low      |
| E-0.1    | Granica paketa `editor-core` u Ductusu: `packages/editor-core`, bez Next.js-a, transport kao parametar; isti testovi prije i poslije          | Ductus                        | nakon 16. 11.                                                 | critical |
| E-0.2    | Objava `@ductura/editor-core` 0.x iz Ductusa                                                                                                  | Ductus                        | E-0.1, odluka 2                                               | critical |
| E-0.3    | Selidba paketa u web-chrome po uvjetima izlaza (§2d)                                                                                          | web-chrome                    | VS-1, zamrzavanje Ductusa                                     | critical |
| Uski rez | Sesija, `open`, `commit`, `replay` kao zasebni `critical` PR-ovi redom (O-3, §4c); ID-eve dodjeljuje orkestrator                              | server                        | S-0.19                                                        | critical |
| VS-1     | Vertikalni presjek: prijava, otvori, spremi rečenicu, osvježi; samo sintetički podaci; uključuje VS-1.13 (O-2)                                | preloader, web-chrome, server | S-1E-a, S-1D-d, S-1M-a, uski rez (ranije S-M-5), E-0.2, P-0.1 | critical |
| VS-1b    | `202 pending_signature`, worker, red poslova, oporavak; uvjet za osnovicu 20. 12. 2026. i za stvarne podatke (O-2)                            | server, web-chrome            | VS-1                                                          | critical |
| VS-2     | Isti rad otvoren na mobitelu                                                                                                                  | web-mobile ili web-chrome     | VS-1, odluka 13                                               | standard |
| M-0.1    | Mjere razdvajanja i DORA u `orch:metrics` (repozitorija po promjeni, čekanje na drugi repo, vrijeme do testiranog izdanja)                    | Ductus                        | S-0.21                                                        | standard |

### 10c. Raspored

**Tjedan 1 (17.–21. 11.)**

- Ti: V-0 e-pošta (domena odlučena 17. 11.: `ductura.org`). V-1 organizacija i repozitoriji. Odgovori na odluke 1–6, 11 i 14–16.
- U Ductusu odmah: S-0.1 (s izmjenom iz 10a), S-0.2, S-0.3, S-0.21.
- Nakon V-1: S-0.4, zatim S-0.5, S-0.7 i S-0.16 usporedno.

**Tjedan 2 (24.–28. 11.)**

- Ti: V-2 zaštita grane, V-3 prijenos i instalacija aplikacije botova i Codex, V-4 tajne.
- Server: S-0.6, S-0.8, S-0.12, zatim S-0.9, S-0.11, S-0.13, S-0.14.
- `.github`: T-0.2 (u sklopu kojeg se pišu S-0.10-a i S-0.10-b, nakon S-0.9). Redoslijed V-2 (§7): S-0.9 i S-0.10-b dokažu prolaz i očekivani pad prije nego V-2 dopiše statuse.
- T-0.6 i M-0.1 u Ductusu, nakon S-0.21. Mjere počinju s prvim PR-om u serveru.
- E-0.1 u Ductusu (granica paketa editora), nakon prezentacije i uz pisca koji poznaje `src/editor`.
- Ako je pisac slobodan: P-0.1 i P-0.2 (bez servera).

**Izlaz iz dva tjedna:** `Ductura/server` ima CI s `ci-ok`, gate i botove, a jedan pravi PR prošao je cijeli gate. Migracije su prenesene s istim ledgerom. Orkestrator prati server iz svojih skripti. Odluke 1–6, 11 i 14–16 su zapisane na #87.

Ostatak vala 0 (S-0.15, S-0.17, S-0.18, S-0.19) i T-0.1, T-0.4 i T-0.7 ide u treći tjedan. **Uski rez servera (O-3, §4c) počinje odmah iza S-0.19**, dakle u trećem tjednu, kao zasebni `critical` PR-ovi redom, usporedno s valovima 1 do 5. Uvjeti početka: S-0.19 spojen, plan napada za svaki dio, ne više od tri kodna PR-a po repou. VS-1 i VS-1b slijede iza reza (§4a-1), a kontrolna točka 20. 12. 2026. traži VS-1b i izbor sustava za pilot (§4d). T-0.2 (s S-0.10-a/b) je u drugom tjednu jer je preduvjet za T-0.4, T-0.7 i za V-2.

<a id="katalog-zadataka"></a>

## Katalog zadataka

Stavke imaju izvorni ID kako bi postojeći zadaci, PR-ovi i dodjele ostali povezani. Stavke iz različitih izvora koje opisuju isti ishod upućuju na isti izvršni prihvat. Datirani statusi, prijedlozi, ovisnosti o ranijem ustroju i procjene u priloženim zapisima provjeravaju se prema redoslijedu i aktualnim odlukama iz gornjih poglavlja.

### Raspodjela značajki po valovima

Lokalna specifikacija preuzeta iz radne dokumentacije. SHA-256 normaliziranog teksta izvornika 2038ce7c277769d9195b55ede1edba96cc5332301c10c42b2f95a02a57ad9956.

<!-- VALOVI-START -->

Datum: 19. 11. 2026. Izvori: `INVENTAR-editor.md` (oznaka **E§**), `INVENTAR-student.md` (**S:** E-n, PD-n, R-n, PO-n), `INVENTAR-nastavnik.md` (**N:** N-nn). Pitanja su u `PITANJA-ZA-DANIELA.md` (oznake 0, A-n, B-n, C-n). Danielovi odgovori (43/43, 19. 11.) su u `ODGOVORI-DANIEL-2026-11-19.md`; oznaka **✓** znači riješeno. Zadaci za valove 1, 2 i 4: `ZADACI-VAL-1-2-4.md`.

## Pravila koja vrijede za svaki val

- Ekrani i prozori su funkcionalno isti kao u prototipu. Editor je isti i po funkciji i po izgledu („papir i grafit”).
- Provjere tek na kraju: nema reviewa ni QA-a, osim jednog reviewa kritičnih PR-ova (dopuna faze 2, 19. 11.). Prije spajanja u granu ide lokalno: install, typecheck, testovi i build.
- Svi frontovi koriste `@ductura/ui`. Novi UI element prvo ide u `ui` (DAN-1111), tek onda u web.
- Front je Next.js i podatke dobiva samo preko Institution_server `/api/v1`. Front ne piše izravno u tablice.
- Svaka nova tablica dobiva RLS i retke u pgTAP matrici pristupa, u istom PR-u.
- PR ima najviše oko 300 redaka. U testovima i fixtureima su samo izmišljeni tekst i izmišljene osobe (✓ 0: primjer je `editor/samples/primjer-izmisljeni.json`).
- **Kraj vala:** Daniel lokalno pokrene server i web zajedno, prođe zadani tok i odobri. Tek onda kreće sljedeći val. Paralelni valovi grade se istodobno, a odobravaju zasebno.

Repoi: **SRV** je Institution_server, **WEB** je Institution_front_web_chrome, **UI** je paket `@ductura/ui` (ako stoji unutar WEB-a, PR ide u WEB).

## Odluke 19. 11. (Daniel) i odluke orkestratora

- ✓ A-1 početna studenta je „Moji zadaci” (`/zadaci`). ✓ A-2 kod 8–32 znaka; normalizira server; ugovor smije razlikovati „već upisan” i „kolegij bez zadatka”. ✓ A-3 `student.assignments.get` se proširuje (akademska godina, grupe, vrsta rada, mentor, produljeni rok, nastavnici kolegija); novo glavno izdanje `@ductura/contracts`.
- ✓ A-4 vrijedi 8 stanja iz `SaveState` (`ui`). ✓ A-5 403 na `/me` je stanje „bez uloge”; tekst upućuje na administratora fakulteta (koordinator = admin fakulteta).
- ✓ A-6 odjava: dijalog ostaje; odjava završava i AAI sesiju (`auth.logout.post` s krajem sesije kod pružatelja; lokalno lažni OIDC); nakon odjave javna početna stranica `/`.
- ✓ A-7 kolegij izrađuje **administrator** ustanove (`/ustanova/kolegiji`), s nositeljem i grupama; nastavnik ga ne izrađuje. ✓ A-8 kod se prikazuje jednom; server već čuva samo `code_hash`. ✓ A-9 „Zbirni” ulazi u bočnu traku nastavnika (4 stavke).
- ✓ A-10 dodatni web ekrani ostaju (student: reprodukcija, dnevnik pristupa, „Kako radi”, stanje, prijava problema, pretraga i godina na „Moji radovi”; nastavnik: jezik rada, nova verzija zadatka). ✓ A-11 N-01 do N-18 iz kartica su kanonski.
- ✓ A-12 druga kartica: blokada iz editor-corea. ✓ A-13 fontovi lokalno, izvori preko servera, vanjske stranice kao obične poveznice. ✓ A-14 pravila o alatima postavlja nastavnik u zadatku; „pogled uživo od prvog dana” ostaje.
- ✓ B-1 i ✓ B-2: Daniel želi „Podrijetlo teksta” (ritam unosa, postotci, pragovi) i podudaranje s automatskim prilaganjem kao u prototipu. To traži izmjenu pravila: **korak P-1** ispod. Do tada se ti dijelovi ne grade.
- ✓ B-3 „Kod potvrđuje da se predani tekst nije mijenjao od predaje.”, naziv bez „autorska”. ✓ B-4 gumb „Otisak u međuspremnik”; svi tekstovi kroz skener. ✓ B-5 „izvornost” samo kao doslovni navod službenog obrasca fakulteta (iznimka skenera ide u P-1).
- ✓ B-6 svaka poruka uspjeha tek uz potpisanu potvrdu, do tada „Šalje se…”. ✓ B-7 oznaka lijepljenja ostaje, uz napomenu da je tekst kasnije mijenjan. ✓ B-8 „tekst navoda razlikuje se od priložene stranice”.
- ✓ B-9 potvrđeno 19. 11. („Kritjerij je samo radna bilješka nastavnika”): 6 kriterija samo je nastavnikova radna bilješka; student ne vidi kriterije ni bodove, pa P-1 to ne treba.
- ✓ C-1 shema po valovima. ✓ C-2 `locator` ostaje i prikazuje se kao stranica; `via` i `rq` postaju atributi navoda u shemi v3. ✓ C-3 Izjava (E-9) smije se izgraditi prije D-194, na lažnom serveru: ide u val 3.
- ✓ C-5 napomene da. ✓ C-7 suradnik smije sve (komentar, dorada, izvoz, mentorstva, sve grupe). ✓ C-8 rok dorade u ugovoru. ✓ C-9 prijedlozi teksta jesu proizvod. ✓ C-10 nastavnik uspoređuje bilo koje dvije verzije.
- ✓ C-12 stilovi i Lektini profili ulaze; Lektu daje Daniel, ne čeka se Q-11. ✓ C-13 pomoćnik zadnji, do tada kartica „uskoro”. ✓ C-14 diktiranje i čitanje naglas kroz Web Speech API, preuzimanja da.
- ✓ C-15 grade se svi ekrani, i N-13, N-14, N-15 i N-AI-ATT. N-14, N-15 i N-AI-ATT nemaju prototip: prije gradnje ide nacrt ekrana u `_prototipovi`. ✓ C-16 Merlin: CSV po prezimenu, poveznica 24 h, PDF i .docx u paketu, popis razloga produljenja.
- ✓ C-17 pri objavi zadatka ne šalje se ništa dok nema kanala. ✓ C-18 banner o prazninama u zapisu se prikazuje (val 5). ✓ C-19 „Pravila oblika” nisu provjera stila FPZG-a; gradi se kako je u prototipu (bez funkcije) dok Daniel ne zada sadržaj.
- **✓ C-4, odluka orkestratora.** Stanje `ceka` postoji samo kad server vrati `pending_signature` (protokol 2, asinkrono potpisivanje). Nova ruta `student.submission.get`: `GET /api/v1/student/assignments/{assignmentId}/submission` vraća `{state: "none" | "ceka" | "potvrdeno", receipt?}`. Čita je E-11 nakon osvježavanja i R-38 „Provjeri stanje predaje”. Nastavnik u valu 5 čita istu potvrdu rutom `teacher.submission-receipt.get` (RLS po kolegiju).
- **✓ C-6, odluka orkestratora.** `/provjera` je javna stranica na instanci ustanove (ne `ductura.org`), bez prijave i bez kolačića sesije. QR sadrži `https://<instanca>/provjera#r=<id potvrde>&o=<otisak>` (fragment, pa ne ide u zapisnike). Stranica šalje `POST /api/v1/public/verification` (`public.verification.post`, ograničen broj zahtjeva). Server provjerava Ed25519 potpis i otisak kroz usku SECURITY DEFINER funkciju, koja vraća samo „podudara se / ne podudara”, vrijeme predaje, vrijeme potpisa i id ključa: bez imena, kolegija i teksta. Nikad ne izdaje sesiju (D-09). PDF potvrde radi server, samo za prijavljenog studenta i nastavnika kolegija.
- **✓ C-11, odluka orkestratora.** Za zajedničke podatke vrijedi nastavnički prototip: redak verzije stoji na potvrdi za oba korisnika; studentska poveznica na nepostojeću „3. Analizu” vodi na PD-1 Sažetak procesa; nastavnici kolegija dolaze sa servera (nositelj i članovi kolegija, polje iz A-3), isti popis u oba sučelja.

## Korak P-1: izmjena pravila proizvoda: čeka izmjenu pravila (Daniel odlučio 19. 11.)

Daniel je 19. 11. odlučio da se „Podrijetlo teksta” i podudaranje s pomoćnikom grade kao u prototipu i da se proizvod mijenja. To nije obična gradnja: ritam unosa su vremena između tipki, nova vrsta osobnih podataka. Prije gradnje tih dijelova mora sletjeti docs promjena:

1. PRODUCT §5: pravila 1 (tvrdnja o korištenju AI-ja), 2 (postotak), 4 (bilježenje tipki i ritma), 8 (atribucija), 13 (analiza procesa pisanja) i rječnik zabranjenih izraza; uz to iznimka skenera za doslovni navod službenog obrasca (B-5).
2. Ustav (Product Constitution v1.4), ako ga te granice pokrivaju: izmjena traži izričitu Danielovu potvrdu teksta.
3. Privatnost i DPIA: nova klasa podataka (vremena unosa), svrha, rok čuvanja (D-30 je još PRIJEDLOG), tko vidi, obavijest studentu; utjecaj na `docs/privacy/` i DPIA uz DPO-a (D-142/D-143).
4. Tekst „Što se bilježi” (val 6) mijenja se u istom koraku, da ne tvrdi suprotno od onoga što se bilježi.

Tek nakon P-1: bilježenje ritma u editoru i evidence zapisu (zaseban SRV + editor niz, prije vala 9), Karta podrijetla N-10 (val 9), Pragovi (val 11), Podudaranje i automatsko prilaganje te oznaka `aitext` (val 12). P-1 mora sletjeti prije nego što valovi 9, 11 i 12 dođu do tih dijelova; ostatak tih valova ide bez čekanja.

## Shema dokumenta: nesklad i gdje se rješava

**Nesklad.**

- Prototip editora koristi `bulletList`/`listItem`, `blockquote`, citat `{page, via, rq}` i `hid` samo na naslovima.
- Ima još 9 čvorova i atributa (fusnota, unakrsna poveznica, prikaz, formula, fxi, prijelom stranice, okvir, blok koda, `vg`) i 8 oznaka (paste, imported, hl, sup, sub, lang, aitext, link) (E§6).
- editor-core (V2 kanonska shema) i server (`server/domain/document/schema.ts`) poznaju samo odlomak, h1–h3, `bulletItem`, `quote`, podebljano, kurziv i citat `{sourceId, locator}`.
- Server odbija svako nepoznato polje (pravilo B-8 iz `STATE.md`, nije pitanje s popisa). Dokument iz prototipa zato ne prolazi commit, a izmjena sheme samo u webu ruši spremanje.

**Rješenje.**

1. Val 1 radi na postojećoj V2 shemi. Prikaz se prilagođava shemi: popis i citat crtaju se iz V2 čvorova kako izgledaju u prototipu, a stranica se prikazuje iz `locator` (✓ C-2).
2. Svako proširenje je zaseban niz PR-ova „shema vN”, nikad samo u jednom repou, uvijek ovim redom:
   1. ugovor i JCS test vektori;
   2. server `schema.ts` i validacija, uz migraciju verzije i test koji čita dokument stare verzije;
   3. editor-core;
   4. tek onda UI.
3. Proširenja idu korak po korak, po valu koji ih treba (✓ C-1):
   - **shema v3**, val 7: fusnota, unakrsna poveznica, atributi navoda `via` i `rq` (✓ C-2);
   - **shema v4**, val 10: prikaz, formula, fxi, prijelom stranice, okvir, blok koda, `vg`, oznake sup, sub, hl, lang i link, te `paste` i `imported` (✓ B-7: oznaka ostaje uz napomenu o kasnijoj izmjeni);
   - oznaka `aitext` ide u val 12, nakon P-1 (B-2).

## Redoslijed i paralelnost

| Val | Naziv                                                                                  | Paralelno s             | Repo              |
| --- | -------------------------------------------------------------------------------------- | ----------------------- | ----------------- |
| 1   | Jezgra editora: pisanje i potvrda (+ Next.js temelj weba)                              | 2, 4                    | WEB + UI (+2 SRV) |
| 2   | Student: ljuska, prijava, upis, obavijesti                                             | 1, 4                    | SRV + WEB         |
| 3   | Student: radni prostor, Izjava, predaja, potvrda                                       | nakon 1, 2 i 4          | SRV + WEB         |
| 4   | Nastavnik: ljuska, kolegiji, novi zadatak; admin izrađuje kolegij                      | 1, 2                    | SRV + WEB         |
| 5   | Nastavnik vidi predaju                                                                 | 6                       | SRV + WEB         |
| 6   | Izgled editora: trake, paneli, ladice                                                  | 5                       | WEB + UI          |
| 7   | Citati i izvori (shema v3)                                                             | 8                       | SRV + WEB         |
| 8   | Suradnja mentora: komentari, dorada, prijedlozi                                        | 7                       | SRV + WEB         |
| 9   | Zapis procesa: sažetak, reprodukcija, usporedba, provjera                              | 10                      | SRV + WEB         |
| 10  | Bogati sadržaj i stranice (shema v4), izvoz                                            | 9                       | SRV + WEB         |
| 11  | Provjere teksta, etape, konzultacije, Merlin, produljenje (11a student, 11b nastavnik) | 11a i 11b međusobno, 12 | SRV + WEB         |
| 12  | Pomoćnik (nakon D-194)                                                                 | 11                      | SRV + WEB         |

„Paralelno” znači disjunktne datoteke: WEB PR-ovi ne diraju iste rute ni komponente, SRV PR-ovi ne diraju iste rukovatelje. Zajedničke datoteke (ugovori i generirani klijent, `inventory.ts`, `server.ts`, `migrations.sum`, pgTAP matrica, `messages.hr`, izvozi `ui`, lockfile) imaju vlasnika trake ili zadani redoslijed (`ZADACI-VAL-1-2-4.md`).

- Val 7 dira shemu dokumenta, a val 8 rukovatelje `collaboration.*`, pa su disjunktni. Valovi 9 i 10 su disjunktni ako shema v4 (val 10) ne dira replay i projekcije (val 9).

Ograničenja:

- **Next.js temelj weba (val 1) ide prije svih WEB stranica.** Kopija weba nema `next` ni `next.config`; stranice su Next oblika, a 69 datoteka čita bazu izravno (`withActor`, `@/server/*`, a `src/server` u kopiji ne postoji). Svaka stranica u svom PR-u prelazi na `src/client` → `/api/v1`, a pripadni `src/app/api` rukovatelji s bazom se brišu.
- Val 3 traži gotove valove 1, 2 i 4: zadatak koji student otvara stvara nastavnik u valu 4. Val 5 traži val 3, jer nastavnik gleda stvarnu predaju.
- Valovi 1, 2 i 4 dijele SRV PR „lokalni seed”: izmišljeni student, nastavnik, administrator i račun bez uloge, kolegij s nositeljem i grupama, zadatak s obavijesti, rad, valjan i istekao kod. Samo lokalno i u CI-ju, nikad stvarne osobe ni tekstovi.
- Ako Q-6 izabere komentar u dokumentu, sidro komentara ulazi u shemu v3 i val 8 ide nakon vala 7, a ne paralelno.
- Val 6 je samo WEB i UI, pa ide uz val 5, koji je težak na serveru. UI PR-ovi su uska točka: komponente za val n+1 grade se dok Daniel klika val n.

**Rani cijeli tok.** Kad su gotovi valovi 1 do 5 (od toga 1, 2 i 4 paralelno), radi cijeli lanac: administrator izradi kolegij, nastavnik objavi zadatak i izda kod, student se upiše, piše, preda i dobije potpisanu potvrdu, a nastavnik vidi predaju i istu potvrdu.

## Val 1: Jezgra editora: pisanje, potpisana potvrda, ponovno učitavanje

**Što Daniel klikne:**

1. Napiše odlomak, naslov i popis. Status pokaže „Sinkroniziram” pa „Spremljeno na poslužitelju”.
2. Osvježi stranicu i vidi isti tekst.
3. Isključi mrežu i piše dalje. Status pokazuje „Spremljeno na uređaju”, bez „na poslužitelju”. Kad uključi mrežu, vraća se „Spremljeno na poslužitelju”.

**Ekrani:**

- list papira i statusna traka (E§1, status 30 px);
- statični dio trake alata (E§3.6 toolbar2): poništi, ponovi, stil bloka, podebljano, kurziv, popis, citat;
- stari nacrt (EarlierDraft);
- druga kartica, uz blokadu iz editor-corea (✓ A-12).

Stanja spremanja dolaze iz editor-corea (✓ A-4: 8 `SAVE_STATES`). SYNCED se pokazuje samo uz potpisanu potvrdu, a `pending_signature` nije potvrda (✓ B-6).

**Server:**

- evidence open, commit i replay već su montirani i samo se spajaju; novih ruta nema;
- test: commit, potvrda, a replay vraća isti JCS hash.

**WEB temelj:** Next.js u `src/app`, most `/api/v1` prema serveru, čitanje na serveru kroz `src/client`.

**UI prvo:**

- tokeni „papir i grafit”: tamna tema zadana, svijetla kroz `:root[data-theme=light]`, tema lista zasebna (zadano bijela);
- lokalni fontovi (✓ A-13);
- `SaveState` s 8 stanja (✓ A-4).

**PR-ovi:** 8: 2 SRV (lokalni seed, test evidence toka) i 6 WEB/UI (Next temelj, API most, tokeni i fontovi, stranica rada, statična traka, e2e).

**Blokira:** ništa od pitanja (✓ A-4, A-12, A-13, B-6). Traka: Next temelj je preduvjet za sve WEB PR-ove valova 1, 2 i 4.

## Val 2: Student: ljuska, prijava, upis kodom, obavijesti

**Što Daniel klikne:**

1. Prijavi se lažnim OIDC-om kao student i vidi bočnu traku s 5 stavki i „Moje zadatke” (✓ A-1).
2. Upiše kod i prođe stanja upisa: krivi kod, istekao kod, već upisan, kolegij bez zadatka, uspjeh (✓ A-2).
3. Pročita obavijest kolegija, potvrdi je i odjavi se kroz dijalog; završi na javnoj početnoj stranici (✓ A-6).
4. Prijavi se računom bez uloge i vidi stanje „bez uloge” s uputom na administratora fakulteta (✓ A-5).

**Ekrani:**

- S: E-0 ljuska (64 px, izbornik ispod 800 px, tema, odjava s dijalogom), E-1 Prijava (6 stanja);
- E-2 Moji zadaci, E-3 Moji kolegiji, E-4 Moji radovi (uz pretragu i godinu, ✓ A-10);
- E-5 Upis kodom (7 stanja), E-6 Obavijest (8 stanja, tekst prema ✓ A-14);
- prozori PD-5 do PD-8, radnje R-1 do R-15;
- dodatni web ekrani ostaju (✓ A-10): dnevnik pristupa, „Kako radi”, stanje.

**Server:**

- već montirano: auth, me, locale;
- samo ugovor, treba rukovatelj: `student.assignments.get`, `institution.enrollments.post`, `institution.acknowledgment.post`, `student.access-log.get`;
- novo: ugovor „obavijest pročitana” (PO-7) s tablicom potvrda čitanja (RLS, pgTAP); proširenje `student.assignments.get` (✓ A-3); ishodi upisa „već upisan” i „kolegij bez zadatka” (✓ A-2).

**UI prvo:** dijalog sa zarobljenim fokusom, toast, skeleton, oznaka, kvačica, odabir, detalji, izbornik ljuske.

**PR-ovi:** 18: 8 SRV (ugovori i njihovo izdanje, 3 migracije, 3 rukovatelja) i 10 UI/WEB.

**Blokira:** ništa od pitanja (✓ A-1, A-2, A-3, A-5, A-6, A-10, A-14). Stranice koje koriste nove ugovore čekaju izdanje ugovora i podizanje verzije u WEB-u.

## Val 3: Student: radni prostor, Izjava, predaja, potpisana potvrda

**Što Daniel klikne:**

1. Otvori zadatak iz vala 2 i piše u editoru iz vala 1.
2. Otvori „Prije predaje”, vidi provjere, prođe Izjavu, preda rad i potvrdi u prozoru „Predati rad?”.
3. Dobije potvrdu s otiskom. Nakon osvježavanja potvrda se učitava sa servera (C-4).

**Ekrani:**

- S: E-7 Radni prostor (6 stanja), E-8 Prije predaje, E-9 Izjava (✓ C-3, na lažnom serveru; naziv obrasca doslovno prema ✓ B-5 tek nakon iznimke skenera iz P-1), E-10 Predaja (10 stanja);
- E-11 Potvrda (redak verzije prema ✓ C-11, gumb „Otisak u međuspremnik” ✓ B-4), bez PDF-a, QR-a i javne provjere, koji dolaze u valu 9;
- PD-1 Sažetak procesa (osnovni dijelovi), PD-3 Predati rad?, PD-4 Napomena.

**Server:**

- samo ugovor, treba rukovatelj:
  - `submission.submit.post`, koji vraća `SignedSubmissionReceiptV2` (Ed25519);
  - `student.assignment-work.get`;
  - `projection.process-summary.post`;
- novo:
  - `student.submission.get` i stanje `ceka` (✓ C-4, odluka orkestratora gore);
  - napomene (PO-15): ugovor i tablica samo za dodavanje, s RLS-om i pgTAP retcima (✓ C-5);
  - redovi provjera (PO-14) i raspon riječi (PO-12) iz postavki zadatka;
  - Izjava: dio s pomoćnikom samo na lažnom serveru (`@ductura/test-fakes`), bez stvarnih rukovatelja do D-194.

**UI prvo:** koraci, prikaz otiska, popis ključ–vrijednost.

**PR-ovi:** oko 12: 5 SRV i 7 UI/WEB.

**Blokira:** ništa od pitanja (✓ B-4, C-3, C-4, C-5, C-11). Naziv obrasca u Izjavi čeka iznimku skenera (P-1); do tada stoji neutralan naziv.

## Val 4: Nastavnik: ljuska, kolegiji, novi zadatak, kod za upis; admin izrađuje kolegij

**Što Daniel klikne:**

1. Kao administrator na `/ustanova/kolegiji` izradi kolegij s nositeljem i grupama (✓ A-7).
2. Kao nastavnik vidi kolegije i bočnu traku s 4 stavke, i „Zbirni” (✓ A-9).
3. Izradi i objavi novi zadatak, uz pravila o alatima (✓ A-14).
4. Izradi novi kod za upis, vidi ga samo jednom (✓ A-8) i opozove stari. Student iz vala 2 upiše se tim kodom.

**Ekrani:**

- N: N-01 kolegiji, N-02/03 novi zadatak **bez obrasca kolegija** (✓ A-7: `submit:course` i varijanta `kolegij-stvoren` ne grade se za nastavnika; prazni nastavnik vidi uputu da kolegij izrađuje administrator), dijalog dk-h;
- admin: obrazac „Novi kolegij” na postojećem `/ustanova/kolegiji` (A-03); prototipa nema, gradi se iz `ui` elemenata u izgledu tog ekrana;
- postojeće web komponente: TeacherCourses, TeacherSetup, AssignmentVersionForm (✓ A-10).

**Server:**

- `institution.courses.post` postaje samo administratorov, s poljem nositelja (nova RPC `institution.admin_create_course`, RLS i pgTAP retci); nastavnički `create_course` ostaje u bazi, ali ga ruta više ne zove;
- već montirano: izrada i opoziv koda za upis (čuva se samo sažetak, ✓ A-8);
- samo ugovor, treba rukovatelj: `teacher.access.get`, `teacher.courses.get`, `institution.assignment-versions.post`;
- izrada zadatka: `server/institution/assignment-route.ts` postoji, ali nije spojen (PENDING). Treba ugovor, zatim spajanje;
- grupe: `course_team_groups` postoji samo kao migracija. Treba ugovor i rukovatelj (administrator i nositelj), uz provjeru RLS-a i pgTAP redaka.

**UI prvo:** iz weba u `ui` prelaze Dialog, PanelTabs, ErrorScreen i RouteLoading.

**PR-ovi:** 10: 6 SRV i 4 WEB.

**Blokira:** ništa od pitanja (✓ A-7, A-8, A-9, A-10, A-11, C-17: pri objavi se ne šalje ništa).

## Val 5: Nastavnik vidi predaju

**Što Daniel klikne:**

1. Vidi studente i radove sa stanjem predaje.
2. Čita rad iz vala 3 uživo, samo za čitanje.
3. Otvori predaju i vidi istu potvrdu, otisak i redak verzije koje je vidio student (✓ C-11).
4. Otvori zbirni pregled i prihvati ili odbije zamolbu za mentorstvo; vidi banner o prazninama u zapisu kad ih ima (✓ C-18).

**Ekrani:**

- N: N-04 studenti, N-16 mentorstva (dijalog do-h), N-17 zbirni, N-06 rad (pogled uživo, banner praznina), N-07 predaja;
- postojeće web komponente: MentoredWorks, LiveWorkView.

**Server:**

- samo ugovor, treba rukovatelj: `teacher.submissions.get`, `teacher.assignment-submissions.post`, `teacher.mentorships.get`, `teacher.mentorship.get`, `live.document.get`, `institution.student-removal.post`, `institution.student-return.post`;
- `teacher_rosters` i `mentorship_request` postoje samo kao migracije: ugovor i rukovatelj, uz provjeru RLS-a i pgTAP redaka; novo: `teacher.submission-receipt.get` (✓ C-4), uz RLS po kolegiju; suradnik ima ista prava kao nositelj (✓ C-7).

**UI prvo:** tablica s popisom, oznaka stanja.

**PR-ovi:** oko 9: 5 SRV i 4 WEB.

**Blokira:** ništa od pitanja (✓ B-4, C-7, C-11, C-18).

## Val 6: Izgled editora: ljuska, trake, paneli, ladice

Samo WEB i UI, paralelno s valom 5.

**Što Daniel klikne:**

1. Provjeri da editor izgleda kao prototip na 1250, 1050, 760 i 640 px.
2. Mijenja raspored panela A/B/C i otvara ladice, način fokusa i traku za traženje.
3. Otvara Ctrl+K, prečace i kontekstne izbornike.
4. Mijenja temu lista neovisno o temi ljuske.

**Ekrani:**

- E§1: zaglavlje 48 px, alati 44 px, stup 248/288/340, list najviše 820, panel 300/340/400;
- E§3.1: rasporedi i ladice;
- E§3.6:
  - toolbar2: Posebni znak, Oznake, cmdk, Prečaci, Prilagodi traku, selBub, mbar;
  - more2: kontekstni izbornik, kratice;
- E§3.3: izbornici Umetni, Pretvori, Više, Izvezi i Prikaz. Stavke bez funkcije vidljive su, ali onemogućene;
- E§3.2: popoveri @ i /, obavijesne trake (banneri);
- E§3.3: pomoć, Prvi koraci, Prije prve rečenice, Što se bilježi (tekst se mijenja u P-1 ako se počne bilježiti ritam);
- postojeće komponente: EditorToolbar, ToolbarMenu, HeadingOutline, SidePanels, StatusLength.

**Server:** ništa (raspored se pamti lokalno u pregledniku). **UI prvo:** ladica, paleta naredbi, dijalog prečaca, traka za traženje, kontekstni izbornik, popover.

**PR-ovi:** oko 10, svi UI i WEB.

**Blokira:** ništa.

## Val 7: Citati i izvori (shema v3)

**Što Daniel klikne:**

1. Doda izvor ručno i preko DOI/ISBN-a, pa umetne citat sa stranicom.
2. Promijeni stil citiranja ili Lektin profil, umetne fusnotu i unakrsnu poveznicu.
3. Otvori „Za provjeru” i „Pregled literature”.
4. Osvježi stranicu i sve ostaje spremljeno uz potvrdu.

**Ekrani:**

- E§3.2: popover citata, Za provjeru;
- E§3.3: Brzi izvor;
- E§3.4: sources2 (DOI/ISBN, preporučeni i obvezni izvori, Pregled literature), Dijelovi rada, Poveznica;
- postojeća komponenta: SourcesPanel.

**Server:**

- shema v3, redom kako je opisano gore (fusnota, unakrsna poveznica, `via`, `rq`);
- novo: tablica izvora rada (RLS, pgTAP);
- DOI/ISBN se traži preko servera, bez poziva iz preglednika (✓ A-13);
- stilovi i Lektini profili su postavka ustanove (✓ C-12), kroz `settings.catalogue.get` i `settings.values.get`, koji su samo ugovor i trebaju rukovatelj.

**UI prvo:** popover s obrascem, popis s pretraživanjem.

**PR-ovi:** oko 10: 5 SRV i 5 WEB.

**Blokira:** ništa od pitanja (✓ C-1, C-2, C-12).

## Val 8: Suradnja mentora: komentari, dorada, prijedlozi, brzi put

**Što Daniel klikne:**

1. Kao nastavnik ostavi komentar na odlomak i opći komentar, predloži izmjenu teksta i vrati rad na doradu s rokom.
2. Kao student vidi komentar, prijedlog i zahtjev, odgovori i pošalje doradu.
3. Nastavnik vidi novu rundu i povijest rundi, te koristi brzi put.

**Ekrani:**

- N: N-06/07/08 komentari, dorada i prijedlozi (dijalog dd-h), N-05 brzi put;
- E§3.5: comments2 (opći komentari, privatne bilješke, predlošci, povijest rundi, ispis), mentor2 „Vrati na doradu”;
- E§3.2: obrazac komentara;
- E§3.3: Pošalji doradu, Dnevnik dorade;
- postojeće komponente: TeacherComments, CommentPanel, RevisionPanel, FastPath.

**Server:**

- samo ugovor, treba rukovatelj: `collaboration.comments.post`, `collaboration.revision-requests.post`, `teacher.fast-path.post`;
- `live.document.put` za prijedloge teksta (✓ C-9);
- novo: rok dorade u ugovoru (✓ C-8), tablice privatnih bilješki i predložaka (RLS, pgTAP).

**UI prvo:** nit komentara, odabir datuma.

**PR-ovi:** oko 11: 6 SRV i 5 WEB.

**Blokira:** Q-6 iz `STATE.md`: D-133/D-134, arhitektura komentara, koju bira vlasnik (✓ C-8, C-9).

## Val 9: Zapis procesa: sažetak, reprodukcija, usporedba, javna provjera

**Što Daniel klikne:**

1. Kao nastavnik otvori sažetak procesa, pusti reprodukciju i usporedi bilo koje dvije verzije (✓ C-10).
2. Bez prijave otvori `/provjera` preko QR-a s potvrde i vidi da se predani tekst nije mijenjao (✓ C-6).
3. Preuzme PDF potvrde.

**Ekrani:**

- N: N-10 sažetak (Karta podrijetla tek nakon P-1), N-09 reprodukcija, N-11 usporedba;
- S: PD-1 svih 11 dijelova, E-11 s PDF-om i QR-om (PO-20, PO-21);
- E§3.3: Povijest rada, Predajni paket (naziv i tekst koda prema ✓ B-3);
- E§3.2: diff;
- E§3.5 mentor3: Pregled runde, Usporedi predaje;
- postojeće komponente: ProcessSummaryView, ReplayView.

**Server:**

- evidence replay je već montiran;
- novo: popis verzija, `public.verification.post` s uskom SECURITY DEFINER funkcijom (✓ C-6), PDF na serveru;
- javna provjera ne smije postati način prijave (D-09);
- nakon P-1: bilježenje ritma unosa i Karta podrijetla (zaseban niz).

**UI prvo:** reproduktor s vremenskom crtom, prikaz razlika.

**PR-ovi:** oko 10 (5 SRV i 5 WEB), plus niz Karte podrijetla nakon P-1 (oko 4).

**Blokira:** Karta podrijetla: čeka izmjenu pravila (Daniel odlučio 19. 11.), korak P-1. Ostalo bez blokade (✓ B-3, B-4, C-6, C-10).

## Val 10: Bogati sadržaj i stranice (shema v4), izvoz

**Što Daniel klikne:**

1. Umetne tablicu, sliku s obrezivanjem, formulu, blok koda, okvir, prijelom stranice i tekst na stranom jeziku.
2. Uveze tekst i vidi oznaku uvezenog i zalijepljenog teksta (✓ B-7).
3. Uredi naslovnicu i oblik stranice, otvori pregled ispisa, izveze i preuzme rad; uključi diktiranje i čitanje naglas (✓ C-14).
4. Osvježi stranicu i sve ostaje spremljeno uz potvrdu.

**Ekrani:**

- E§3.3: Tablica/Slika, Pregled ispisa, Uvoz teksta;
- E§3.4: Strani jezik, Formula (KaTeX, lokalno), blok koda, okvir;
- E§3.6 rich: trake tablice i slike, obrezivanje, paleta markera, Dodaci editora;
- E§3.6 pages: naslovnica, Oblik stranice.

**Server:**

- shema v4, uključivo `paste` i `imported`;
- slike kao privitci rada: tablica s RLS-om i pgTAP retcima;
- izvoz na serveru.

**UI prvo:** traka uz objekt, dijalog s pregledom.

**PR-ovi:** oko 12: 5 SRV i 7 WEB.

**Blokira:** ništa od pitanja (✓ C-1, C-14, B-7). Oznaka `aitext` ide u val 12.

## Val 11: Provjere teksta, etape, konzultacije, izvoz za Merlin, produljenje

**Što Daniel klikne:**

1. **11a, student:** otvori Pregled i Sitnice, pravopis, „Riješi redom”, „Probu predaje” i potvrdu iz izvora.
2. **11b, nastavnik:** postavi etape, pripremi razgovor i zakaže konzultacije, ocijeni kriterije, izveze za Merlin i produlji rok.

**Ekrani:**

- E§3.5 review2: Pregled, Sitnice, Sažetak rada;
- E§3.6 rich: pravopis;
- E§3.4: proofs (blaži tekst ✓ B-8), tools.js, advice.js, wizard, plus.js, Pravila oblika (✓ C-19);
- E§3.5 mentor2: Stanje rada, Etape, Poruke, Konzultacije, Obrasci (naziv ✓ B-5 nakon P-1), Suglasnost, Nakon predaje, Vremenska crta, Moji studenti;
- E§3.5 mentor3: Kriteriji ocjene (✓ B-9, samo bilješka nastavnika), Uz tekst; Pragovi tek nakon P-1;
- N: N-12 konzultacije, N-18 izvoz za Merlin (✓ C-16), N-13 produljenje (✓ C-15), N-14 Priprema za razgovor i N-15 Etape (✓ C-15, nakon nacrta ekrana).

**Server:**

- tablice etapa, konzultacija, poruka, kriterija i produljenog roka (PO-22), svaka s RLS-om i pgTAP retcima;
- izvoz za Merlin (CSV po prezimenu, poveznica 24 h, PDF i .docx, razlozi produljenja);
- pravila provjera i Lektini profili kao konfiguracija ustanove (✓ C-12).

**UI prvo:** kalendar termina, popis provjera s radnjom.

**PR-ovi:** oko 17: 8 SRV i 9 WEB, podijeljeno na 11a i 11b, plus Pragovi nakon P-1.

**Blokira:**

- Pragovi i naziv obrasca: P-1;
- N-14 i N-15: nacrt ekrana (nema prototipa);
- N-13: ADR Q-5 se i dalje piše (rok 30. 11.), ali gradnja ga ne čeka (✓ C-15).

## Val 12: Pomoćnik

**Što Daniel klikne:**

1. Kao student pita pomoćnika unutar dopuštene razine.
2. Tekst iz pomoćnika dobiva oznaku, a podudaranje sam priloži razgovor Izjavi (nakon P-1).
3. Kao nastavnik vidi razgovor i priloge (N-AI-ATT) onoliko koliko odluka dopušta.

**Ekrani:**

- E§3.5 assist/assist2: pomoćnik, izvori, ključevi, upozorenje o osobnim podacima, Podudaranje (✓ B-2, nakon P-1);
- E§3.3: dijalog pitanja; S: PD-2 dijalog razgovora (E-9 Izjava je u valu 3);
- N: N-AI-ATT (✓ C-15, nakon nacrta ekrana);
- diktiranje i čitanje naglas već iz vala 10 (✓ C-14).

**Server:** M9.2, ugovor i rukovatelji pomoćnika nakon D-194 t. 6 i t. 7 (Q-10, rok 15. 12.); shema: oznaka `aitext`.

**UI prvo:** nit razgovora, kartica „uskoro”.

**PR-ovi:** oko 11: 6 SRV i 5 WEB.

**Blokira:**

- Q-10/D-194 (✓ C-13: pomoćnik zadnji);
- P-1 za Podudaranje, automatsko prilaganje i `aitext`;
- N-AI-ATT: nacrt ekrana. Do tada u panelu pomoćnika stoji samo kartica „uskoro”.

## Zbroj

- 12 valova i oko 138 PR-ova, svaki do oko 300 redaka: SRV oko 61, WEB i UI oko 77. Valovi 1, 2 i 4 imaju 36 PR-ova (točan popis u `ZADACI-VAL-1-2-4.md`).
- Uz to korak P-1 (docs promjena pravila, privatnosti i DPIA) i niz Karte podrijetla i bilježenja ritma nakon njega.
- Paralelne skupine: 1+2+4, 5+6, 7+8, 9+10, 11a+11b, a 12 uz 11 kad se odblokira.
- Shema dokumenta mijenja se samo kroz nizove „shema v3” i „shema v4”, i `aitext` u valu 12.
- Pitanje 0 je riješeno: testovi i fixturei editora koriste samo `editor/samples/primjer-izmisljeni.json`; `diplomski.json` ne ide u testove, fixturee ni repoe.

<!-- VALOVI-END -->

### Tehničke stavke valova 1, 2 i 4

Lokalna specifikacija preuzeta iz radne dokumentacije. SHA-256 normaliziranog teksta izvornika 74d3a1d82bb2d532bc6bacfbe249ff9dce3eed15e5d709022e80a185e9466065.

<!-- VAL-1-2-4-START -->

Datum: 19. 11. 2026. Plan: `PLAN-VALOVA.md`. Odgovori: `ODGOVORI-DANIEL-2026-11-19.md`. Inventari: `INVENTAR-editor.md` (E§), `INVENTAR-student.md` (S:), `INVENTAR-nastavnik.md` (N:). Prototipovi su u `_prototipovi` (editor, student, nastavnik).

## Zajednička pravila za svaki PR

- PR do oko 300 promijenjenih redaka koda; generirane datoteke ugovora i lockfile se ne broje, ali se navode u opisu.
- **SRV** = `Institution_server`, bazna grana `migracija/kopija-ductus-backend`. **WEB** = `Institution_front_web_chrome`, bazna grana `migracija/kopija-ductus-front`. **UI** = paket `@ductura/ui` (`packages/ui` u WEB-u).
- Novi UI element prvo ide u `packages/ui` (DAN-1111), pa tek onda u stranicu. Stranica ne definira vlastiti gumb, dijalog ni polje.
- Front je Next.js i podatke dobiva samo preko `/api/v1` (klijent `src/client/api.ts`). Svaki PR stranice briše `src/app/api/**` rukovatelje i `withActor` pozive koje je ta stranica koristila.
- Svaka nova tablica ili RPC: RLS, `GRANT` samo potrebnoj ulozi, retci u pgTAP matrici (`db/main/tests/030-institution-access-matrix.sql` ili `103-m2-actor-matrix.sql`) u istom PR-u.
- Samo izmišljeni podaci: izmišljene osobe (`demo-*`, `sim:*`), izmišljeni kolegiji i tekstovi; editor koristi samo `editor/samples/primjer-izmisljeni.json` (nikad `diplomski.json`).
- Prijava je samo AAI@EduHr; lokalno i u CI-ju lažni OIDC (`localhost:8090`). Nema lozinki, magičnih poveznica ni drugih načina prijave.
- Bez tajni u repou, bez primjene migracija na produkciju.
- **Provjera prije SPREMAN** (bez reviewa i QA-a):
  - SRV: `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm build`; uz bazu `pnpm db:up` i `pnpm test:db`;
  - WEB: `pnpm install`, `pnpm typecheck` (skriptu dodaje WEB-01; do tada `tsc --noEmit`), `pnpm test` (node unit + Playwright), `pnpm build`;
  - u opisu PR-a: koraci klikanja iz „Prihvaćanje”.
- Lokalni stog (SRV `pnpm lokalno`): server `:4000`, edge `:8000`, lažni OIDC `:8090`. Putanje označene „(novo)” u kopiji ne postoje; ostale su provjerene `git ls-tree` 19. 11.
- Tekstovi sučelja na hrvatskom, kroz katalog poruka i skener zabranjenih izraza.

## Trake i vlasništvo zajedničkih datoteka

Najviše 3 pisca u SRV i 3 u WEB istodobno.

| Traka | Repo | Vlasnik zajedničkih datoteka                                                                                                                                                                                                                                                             |
| ----- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-A   | SRV  | `server/contracts/**` (rute, vektori, `generated/`, `openapi/`, `inventory.ts`), lokalni seed                                                                                                                                                                                            |
| S-B   | SRV  | `db/main/migrations/**`, `migrations.sum`, pgTAP matrice; migracije strogo redom                                                                                                                                                                                                         |
| S-C   | SRV  | studentski rukovatelji `server/institution/student-*-route.ts` (novo) i evidence testovi                                                                                                                                                                                                 |
| W-A   | WEB  | Next temelj, `next.config.ts`, `src/client/**` (i podizanje verzije ugovora), `packages/ui/**`, `src/app/ustanova/**`                                                                                                                                                                    |
| W-B   | WEB  | `src/app/zadaci/**`, `src/app/upis/**`, `src/app/prijava/**`, `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/kako-radi`, `src/app/stanje`, `src/app/rad/[assignmentId]/dnevnik-pristupa`, `src/components/student/**`, `src/components/shell/**`, `messages.hr` (samo svoja sekcija) |
| W-C   | WEB  | `src/app/rad/**` (bez `dnevnik-pristupa`), `src/components/editor/**`, zatim `src/app/nastavnik/**`, `src/components/teacher/**`                                                                                                                                                         |

- `server.ts` (montiranje ruta) i lockfile: tko spaja kasnije, rješava konflikt pri rebaseu; generirane datoteke ugovora uvijek se ponovno generiraju (`pnpm contracts:generate`), ne spajaju ručno.
- Trake ne diraju tuđe direktorije. Treba li stranici nova komponenta u `ui`, pisac W-B ili W-C traži je od W-A (zaseban mali UI PR) ili ga sam otvori u `packages/ui` nakon dogovora na koordinacijskom issueu.

## Redoslijed (ovisnosti)

```
SRV-01 seed → SRV-16 (val 1)
SRV-01 → SRV-02 ugovori-student → SRV-03 ugovori-nastavnik → SRV-04 izdanje 3.0.0 → WEB-07 bump → stranice s novim ugovorima
SRV-05 → SRV-06 → SRV-08 → SRV-07 (migracije redom, traka S-B)
WEB-01 Next temelj → WEB-02 API most → WEB-03 tokeni → WEB-04/05/06 ui → stranice
```

---

## Val 1: jezgra editora (8 PR-ova)

### SRV-01 `seed-lokalni` · SRV · traka S-A

- **Datoteke:** `db/main/local/seed.sql`, `db/main/local/lazni-oidc-racuni.json` (novo, za `FAKE_OIDC_ACCOUNTS_FILE`), `scripts/lokalno/config.ts` (put do datoteke računa), `README` odjeljak „Lokalni računi”.
- **Gradi:** u `demo-fakultet`:
  - administrator `demo-admin` (imenovan kroz `appoint_institution_admin`);
  - nastavnici `demo-teacher` (nositelj) i `demo-teacher-2` (suradnik), uloge potvrđene;
  - studenti `demo-student`, `demo-student-2`; račun bez uloge: nastavnički račun `demo-bez-uloge` u datoteci računa, čija uloga u ustanovi nije potvrđena (oblik `sim:<uloga>:<korisnik>@<domena>` iz `scripts/lokalno/lokalno.integration.test.ts` smije se koristiti samo ako domena pada u `demo-fakultet`; pisac provjeri);
  - jedan redak dnevnika pristupa: `demo-teacher` otvorio rad `demo-student` (kroz postojeću funkciju zapisa u shemi `audit`), da se SRV-11 i WEB-13 mogu kliknuti prije vala 5;
  - kolegij „Izmišljeni seminar iz ekologije grada” (2026./2027.) s grupama A i B; objavljen zadatak „Seminarski rad: kućno kompostiranje” s obavijesti kolegija; `demo-student` upisan i ima otvoren rad;
  - kodovi za upis: valjan `UPIS2026DEMO`, istekao `STARI2025KOD` (pohranjen samo `code_hash`);
  - drugi kolegij bez zadatka (za stanje „kolegij bez zadatka”).
- **Prihvaćanje:** `pnpm lokalno` → prijava lažnim OIDC-om kao `demo-admin`, `demo-teacher`, `demo-student` i račun bez uloge; `GET /api/v1/me` vraća očekivanu ulogu (bez uloge: 403).
- **Ovisi o:** ništa. Blokira gotovo sve.

### SRV-16 `test-evidence-tok` · SRV · traka S-C

- **Datoteke:** proširiti `scripts/stack/evidence.integration.test.ts` (postoji) ili novi `server/evidence/evidence-tok.integration.test.ts` (novo) u vitest projektu `integration`.
- **Gradi:** integracijski test: evidence open za rad iz seeda → commit dokumenta iz `primjer-izmisljeni.json` pretvorenog u V2 shemu → potpisana potvrda (Ed25519) → replay vraća isti JCS hash; negativni slučaj: nepoznato polje u dokumentu → odbijeno (B-8).
- **Prihvaćanje:** `pnpm test` zelen; namjerno pokvaren hash u testu pada.
- **Ovisi o:** SRV-01.

### WEB-01 `next-temelj` · WEB · traka W-A

- **Datoteke:** `package.json` (dodati `next`, istu glavnu verziju kao Aplication_front, i skripte `next:dev`, `next:build`, `typecheck`), `next.config.ts` (novo; komentar u `src/app/api/[...path]/route.ts` ga spominje, ali ga u kopiji nema), `tsconfig.json` putanje; `git mv` svih datoteka koje uvoze `@/server/*` ili zovu `withActor` (69 datoteka: stranice, `src/app/api/**` osim `[...path]`, komponente) u `src/_cekanje/` (novo), isključeno iz `tsconfig` i izvan `src/app`, pa ga Next ne gradi ni ne usmjerava.
- **Gradi:** Next.js App Router nad `src/app`; postojeći `dev-server.mjs` (:5173) i `packages/app` (Vite) ostaju netaknuti dok ih stranice ne zamijene. Svaki PR stranice vraća svoju rutu iz `src/_cekanje/` u `src/app` i prebacuje je na `/api/v1`; ono što ostane u `_cekanje` na kraju vala 4 popisano je i čeka svoj val.
- **Prihvaćanje:** `pnpm next:dev` → `http://localhost:3000/` otvara javnu početnu bez greške; `pnpm next:build` i `pnpm typecheck` prolaze.
- **Ovisi o:** ništa. Blokira sve WEB PR-ove.

### WEB-02 `api-most` · WEB · traka W-A

- **Datoteke:** `src/app/api/v1/[...path]/route.ts` (novo, proxy; specifičnija ruta, pa ima prednost pred postojećim `src/app/api/[...path]` koji vraća 404), `src/client/server.ts` (novo: čitanje na serveru kroz `createApi` s kolačićima zahtjeva), `.env.example` (`INSTITUTION_SERVER_URL=http://127.0.0.1:4000`, kao `dev-server.mjs`).
- **Gradi:** sve `/api/v1/*` ide na Institution_server po uzoru na proxy u `dev-server.mjs`; kolačić sesije prolazi u oba smjera; prijava i odjava idu na serverske `/api/v1/auth/*` (stari `src/app/api/auth/*` iz `_cekanje` briše se ovdje); bez ikakvog pristupa bazi u WEB-u.
- **Prihvaćanje:** prijava kao `demo-student` kroz web → `/api/v1/me` u pregledniku vraća studenta; odjava briše kolačić.
- **Ovisi o:** WEB-01, SRV-01.

### WEB-03 `ui-tokeni-fontovi` · UI · traka W-A

- **Datoteke:** `packages/ui/src/tokens.css`, `packages/ui/src/fonts/**`, `packages/ui/src/icons/**` (ikone trake alata za WEB-15), `packages/ui/src/save-state.ts` (stanja već postoje; dodaje se komponenta).
- **Gradi:** tokeni „papir i grafit” (tamna ljuska zadana, svijetla `:root[data-theme=light]`, tema lista zasebna, zadano bijela) prema `docs/design/DESIGN-SYSTEM.md` i prototipu editora; fontovi lokalno (A-13); `SaveState` komponenta s 8 stanja (A-4), SYNCED tekst „Spremljeno na poslužitelju”.
- **Prihvaćanje:** Storybook ili testna stranica `/ui-pregled` (samo dev) pokazuje sve tokene u obje teme i 8 stanja spremanja.
- **Ovisi o:** WEB-01.

### WEB-14 `editor-stranica` · WEB · traka W-C

- **Datoteke:** `src/app/rad/[assignmentId]/page.tsx` (novo; postoji samo `src/app/rad/page.tsx`), `src/components/editor/EditorPage.tsx` i `StatusBar.tsx` (novo); koristi postojeće `OpenWork`, `EarlierDraft`, `document-saver`, `OfflineNotice` iz `src/components/editor`, vraćene iz `_cekanje` i prebačene na `/api/v1`.
- **Gradi:** list papira (E§1, širina do 820) i statusna traka 30 px sa `SaveState`; editor-core V2: dnevnik (Dexie), sync, `serverSync`; evidence open pri otvaranju; SYNCED samo uz potpisanu potvrdu (B-6); druga kartica: blokada iz editor-corea (A-12) s tekstom `BLOCKED_TEXT`; stari nacrt (EarlierDraft) iz dnevnika.
- **Prihvaćanje:** kao `demo-student` otvori rad iz seeda → piše → „Sinkroniziram” pa „Spremljeno na poslužitelju”; osvježi → isti tekst; mreža isključena → „Spremljeno na uređaju”; druga kartica → blokada.
- **Ovisi o:** WEB-02, WEB-03, SRV-01.

### WEB-15 `editor-traka-staticna` · WEB · traka W-C

- **Datoteke:** postojeći `src/components/editor/EditorToolbar.tsx` i `EditorToolbarFor.tsx`; ikone iz `packages/ui` (WEB-03).
- **Gradi:** statični dio trake (E§3.6 toolbar2): poništi, ponovi, stil bloka (odlomak, H1–H3), podebljano, kurziv, popis, citat; samo čvorovi V2 sheme (popis = `bulletItem`, citat = `quote`), izgled kao u prototipu.
- **Prihvaćanje:** svaki gumb mijenja tekst; Ctrl+Z/Ctrl+Y rade; stanje gumba prati odabir; spremanje i dalje „na poslužitelju”.
- **Ovisi o:** WEB-14.

### WEB-16 `editor-e2e` · WEB · traka W-C

- **Datoteke:** `e2e/editor-val1.spec.js` (novo, uz postojeće `e2e/*.spec.js` i `e2e/support/axe.js`).
- **Gradi:** Playwright tok iz „Prihvaćanja” WEB-14 i WEB-15 na lokalnom stogu (server + lažni OIDC), uz axe na 1250 i 400 px.
- **Prihvaćanje:** `pnpm test:functional` zelen lokalno.
- **Ovisi o:** WEB-15, SRV-16.

**Kraj vala 1:** Daniel pokrene `pnpm lokalno` (SRV) i `pnpm dev` (WEB) i prođe tri koraka iz plana.

---

## Val 2: student (18 PR-ova)

### SRV-02 `ugovori-student` · SRV · traka S-A

- **Datoteke:** `server/contracts/routes/student.ts`, `server/contracts/routes/enrollment.ts`, `server/contracts/vectors/*.json`, `server/contracts/generated/*`, `server/contracts/inventory.ts`.
- **Gradi:**
  - `student.assignments.get` prošireno (A-3): akademska godina, grupe, vrsta rada, mentor, produljeni rok, nastavnici kolegija (`{id, ime, uloga: nositelj|suradnik}`);
  - `institution.enrollments.post` ishodi (A-2): `enrolled`, `invalid_code`, `expired_code`, `already_enrolled`, `enrolled_no_assignment`; kod 8–32 znaka, normalizira server;
  - novo `student.notice-read.post` (PO-7);
  - JCS vektori za sve nove oblike; `contracts:breaking` označava glavno izdanje.
- **Prihvaćanje:** `pnpm contracts:generate` bez razlike nakon commita; `pnpm test` (vektori) zelen.
- **Ovisi o:** SRV-01.

### SRV-04 `ugovori-izdanje` · SRV · traka S-A

- **Gradi:** `pnpm release:tarball` za `@ductura/contracts` 3.0.0 (glavno izdanje) sa studentskim i nastavničkim/admin ugovorima zajedno, tarball u Releases. Jedno izdanje i jedno podizanje verzije u WEB-u za sva tri vala.
- **Prihvaćanje:** tarball se instalira u čistom direktoriju.
- **Ovisi o:** SRV-02, SRV-03 (ista traka S-A, odmah iza seeda).

### SRV-05 `mig-upis-ishodi` · SRV · traka S-B

- **Datoteke:** nova migracija, `migrations.sum`, pgTAP.
- **Gradi:** `enroll_with_code` vraća `already_enrolled` i `enrolled_no_assignment`; kod se normalizira (velika slova, bez razmaka) prije usporedbe s `code_hash`.
- **Prihvaćanje:** pgTAP: svih 5 ishoda; drugi student ne vidi tuđi upis.
- **Ovisi o:** SRV-01.

### SRV-06 `mig-obavijest-procitana` · SRV · traka S-B

- **Gradi:** tablica `institution.notice_read (assignment_id, student_id, read_at)` samo za dodavanje (novo), RLS (student piše i čita svoje, nastavnik kolegija čita), RPC `institution.mark_notice_read` (novo); pgTAP retci.
- **Prihvaćanje:** pgTAP matrica: student da, drugi student ne, nastavnik kolegija čita, nastavnik drugog kolegija ne.
- **Ovisi o:** SRV-05 (redoslijed migracija).

### SRV-08 `mig-zadaci-studenta` · SRV · traka S-B

- **Gradi:** funkcija čitanja zadataka studenta s poljima iz A-3 (grupe, mentor, produljeni rok, nastavnici kolegija), RLS po upisu; pgTAP.
- **Prihvaćanje:** pgTAP: student vidi samo zadatke svojih kolegija; polja odgovaraju seedu.
- **Ovisi o:** SRV-06.

### SRV-09 `h-student-zadaci` · SRV · traka S-C

- **Datoteke:** `server/institution/student-assignments-route.ts` (novo, uz postojeći `student-workspace.ts`), montiranje u `server.ts`.
- **Gradi:** rukovatelj `student.assignments.get` nad SRV-08.
- **Prihvaćanje:** `curl` s kolačićem `demo-student` vraća zadatak iz seeda s nastavnicima kolegija.
- **Ovisi o:** SRV-02, SRV-08.

### SRV-10 `h-upis-obavijest` · SRV · traka S-C

- **Gradi:** rukovatelji `institution.enrollments.post`, `institution.acknowledgment.post`, `student.notice-read.post`.
- **Prihvaćanje:** upis s `UPIS2026DEMO` → `enrolled`; ponovno → `already_enrolled`; `STARI2025KOD` → `expired_code`; obavijest pročitana pa potvrđena.
- **Ovisi o:** SRV-02, SRV-05, SRV-06.

### SRV-11 `h-pristup-dnevnik` · SRV · traka S-C

- **Gradi:** rukovatelj `student.access-log.get` nad postojećim `server/database/my-access-log.ts` (tko je i kada otvorio rad).
- **Prihvaćanje:** `demo-student` vidi redak iz seeda (`demo-teacher` otvorio rad).
- **Ovisi o:** SRV-01 (ugovor već postoji).

### WEB-04 `ui-dijalog-toast` · UI · traka W-A

- **Gradi:** `Dialog` sa zarobljenim fokusom i Esc, `Toast` (aria-live) u `packages/ui`.
- **Prihvaćanje:** `/ui-pregled`: Tab ostaje u dijalogu, Esc zatvara, fokus se vraća na gumb.
- **Ovisi o:** WEB-03.

### WEB-05 `ui-obrasci` · UI · traka W-A

- **Gradi:** kvačica, odabir, višeredno polje, oznaka (tag), skeleton, detalji (`details`).
- **Prihvaćanje:** `/ui-pregled` u obje teme, tipkovnica radi, axe bez nalaza.
- **Ovisi o:** WEB-03.

### WEB-06 `ui-ljuska` · UI · traka W-A

- **Gradi:** premjestiti iz weba u `packages/ui`: PanelTabs, ErrorScreen, RouteLoading, `LogoutDialog` (sada `src/components/editor`), izbornik ljuske (ispod 800 px); web uvozi iz `ui`.
- **Prihvaćanje:** postojeće stranice izgledaju isto; `pnpm build` prolazi.
- **Ovisi o:** WEB-03.

### WEB-07 `ugovori-bump` · WEB · traka W-A

- **Gradi:** `@ductura/contracts` s 2.8.0 na 3.0.0 (Release URL), prilagodba `src/client` parsera (klijent odbija nepoznata polja).
- **Prihvaćanje:** typecheck i testovi zeleni.
- **Ovisi o:** SRV-04.

### WEB-08 `student-ljuska-prijava` · WEB · traka W-B

- **Datoteke:** `src/app/layout.tsx`, `src/components/shell/**` (2 datoteke iz `_cekanje`), `src/app/prijava/page.tsx`, `src/app/page.tsx`; dijalog odjave iz `ui` (WEB-06).
- **Gradi:** S: E-0 ljuska (64 px, bočna traka s 5 stavki, tema, izbornik ispod 800 px), odjava s dijalogom (A-6): odjava iz Ducture i AAI sesije (`auth.logout.post`), zatim `/`; E-1 Prijava sa 6 stanja; 403 na `/me` → stanje „bez uloge” s uputom na administratora fakulteta (A-5).
- **Prihvaćanje:** prijava kao `demo-student` → ljuska i `/zadaci`; odjava kroz dijalog → `/`, ponovni ulaz traži prijavu; račun bez uloge → stanje „bez uloge”.
- **Ovisi o:** WEB-02, WEB-04, WEB-06.

### WEB-09 `student-moji-zadaci` · WEB · traka W-B

- **Gradi:** S: E-2 Moji zadaci (`/zadaci`, A-1) sa stanjima iz inventara; briše `src/app/zadaci` `withActor` datoteke (3).
- **Prihvaćanje:** `demo-student` vidi zadatak iz seeda, rok, nastavnike kolegija; prazno stanje za `demo-student-2`.
- **Ovisi o:** WEB-07, WEB-08, SRV-09.

### WEB-10 `student-kolegiji-radovi` · WEB · traka W-B

- **Gradi:** S: E-3 Moji kolegiji, E-4 Moji radovi uz pretragu i akademsku godinu (A-10).
- **Prihvaćanje:** popis kolegija i radova iz seeda; pretraga filtrira; odabir godine mijenja popis.
- **Ovisi o:** WEB-09.

### WEB-11 `student-upis` · WEB · traka W-B

- **Gradi:** S: E-5 Upis kodom (7 stanja), prozori PD-5/PD-6; briše `src/app/upis` `withActor` (2).
- **Prihvaćanje:** krivi kod, istekao kod, već upisan, kolegij bez zadatka, uspjeh: svaki daje svoje stanje.
- **Ovisi o:** WEB-08, WEB-07, SRV-10.

### WEB-12 `student-obavijest` · WEB · traka W-B

- **Gradi:** S: E-6 Obavijest (8 stanja), PO-7 „pročitano”, potvrda; tekst o pravilima alata i pogledu uživo prema A-14; PD-7/PD-8.
- **Prihvaćanje:** obavijest se otvori, označi pročitanom, potvrdi; nakon osvježavanja ostaje potvrđena.
- **Ovisi o:** WEB-11, SRV-10.

### WEB-13 `student-dodatni-ekrani` · WEB · traka W-B

- **Gradi:** dodatni web ekrani iz A-10 vraćeni iz `_cekanje` i prebačeni na `/api/v1`: `src/app/rad/[assignmentId]/dnevnik-pristupa`, `src/app/kako-radi`, `src/app/stanje`.
- **Prihvaćanje:** dnevnik pristupa pokazuje redak iz seeda; „Kako radi” i stanje se otvaraju bez greške.
- **Ovisi o:** WEB-08, SRV-11.

**Kraj vala 2:** četiri koraka iz plana (prijava, upis kodom, obavijest i odjava, račun bez uloge).

---

## Val 4: nastavnik i administrator (10 PR-ova)

### SRV-03 `ugovori-nastavnik-admin` · SRV · traka S-A

- **Gradi:** `institution.courses.post` (postoji, `routes/institution.ts`) samo za administratora, s `holderId` i grupama; ugovori grupa (`institution.course-groups.*`, novo); `institution.assignments.post` (novo, izrada zadatka); vektori. Izdaje se zajedno sa SRV-02 u SRV-04.
- **Prihvaćanje:** `contracts:generate` bez razlike; vektori zeleni.
- **Ovisi o:** SRV-02 (isti vlasnik, redom).

### SRV-07 `mig-admin-kolegij` · SRV · traka S-B

- **Gradi:** RPC `institution.admin_create_course(name, year, ai_policy, holder)` (SECURITY DEFINER, provjera uloge administratora ustanove); nastavnički `create_course` ostaje, ruta ga više ne zove.
- **Prihvaćanje:** pgTAP: administrator da, nastavnik ne, administrator druge ustanove ne.
- **Ovisi o:** SRV-08 (redoslijed migracija).

### SRV-12 `h-admin-kolegij` · SRV · traka S-A

- **Gradi:** rukovatelj `institution.courses.post` nad SRV-07.
- **Prihvaćanje:** `demo-admin` izradi kolegij; `demo-teacher` dobije 403.
- **Ovisi o:** SRV-03, SRV-07.

### SRV-13 `h-nastavnik-citanje` · SRV · traka S-A

- **Gradi:** rukovatelji `teacher.access.get`, `teacher.courses.get`.
- **Prihvaćanje:** `demo-teacher` vidi kolegij iz seeda i novi kolegij gdje je nositelj.
- **Ovisi o:** SRV-01.

### SRV-14 `h-zadatak-izrada` · SRV · traka S-A

- **Gradi:** spojiti `server/institution/assignment-route.ts` (makni iz PENDING), rukovatelj `institution.assignment-versions.post`; pravila o alatima u zadatku (A-14); pri objavi se ništa ne šalje (C-17).
- **Prihvaćanje:** `demo-teacher` izradi i objavi zadatak; `demo-student` ga vidi nakon upisa.
- **Ovisi o:** SRV-03.

### SRV-15 `h-grupe` · SRV · traka S-A

- **Gradi:** rukovatelji grupa nad `course_team_groups` (administrator i nositelj); provjeriti RLS i dodati pgTAP retke koji nedostaju.
- **Prihvaćanje:** nositelj doda grupu; suradnik (C-7) također; student ne.
- **Ovisi o:** SRV-03.

### WEB-17 `nastavnik-ljuska` · WEB · traka W-C

- **Gradi:** nastavnička ljuska s 4 stavke uključivo „Zbirni” (A-9; prazno stanje do vala 5), nad zajedničkom ljuskom iz WEB-08; `src/app/nastavnik/page.tsx` vraćen iz `_cekanje`.
- **Prihvaćanje:** prijava kao `demo-teacher` → bočna traka s 4 stavke; „Zbirni” pokazuje prazno stanje.
- **Ovisi o:** WEB-07, WEB-08, SRV-13.

### WEB-18 `nastavnik-kolegiji` · WEB · traka W-C

- **Gradi:** N: N-01 kolegiji, dijalog dk-h (izrada i opoziv koda; kod se pokazuje jednom, A-8); prazni nastavnik vidi uputu da kolegij izrađuje administrator (A-7).
- **Prihvaćanje:** izradi kod → vidi ga jednom, nakon zatvaranja samo „izdan”; opozove stari; `demo-student-2` se upiše novim kodom.
- **Ovisi o:** WEB-17, SRV-13.

### WEB-19 `nastavnik-novi-zadatak` · WEB · traka W-C

- **Gradi:** N: N-02/03 bez obrasca kolegija (`submit:course` i `kolegij-stvoren` se ne grade), koraci zs-1 do zs-4, objava; postojeće TeacherSetup i AssignmentVersionForm prebačeni na `/api/v1`; briše `src/app/nastavnik` `withActor` (8) koje ova stranica koristi.
- **Prihvaćanje:** izradi zadatak s pravilima alata i rokom, objavi; student ga vidi u „Mojim zadacima”.
- **Ovisi o:** WEB-18, SRV-14.

### WEB-20 `admin-kolegij-novi` · WEB · traka W-A

- **Gradi:** obrazac „Novi kolegij” na `/ustanova/kolegiji` (naziv, godina, AI pravilo, nositelj, grupe) iz `ui` elemenata, u izgledu postojećeg ekrana A-03 (prototipa nema); briše `src/app/ustanova` `withActor` (4).
- **Prihvaćanje:** `demo-admin` izradi kolegij s nositeljem `demo-teacher-2` i grupom; `demo-teacher-2` ga vidi u N-01.
- **Ovisi o:** WEB-05, WEB-07, SRV-12, SRV-15.

**Kraj vala 4:** četiri koraka iz plana (admin kolegij, nastavnička ljuska, novi zadatak, kod za upis).

---

## Zbroj i trake

| Val        | SRV                                    | WEB/UI                         | Ukupno |
| ---------- | -------------------------------------- | ------------------------------ | ------ |
| 1          | 2 (SRV-01, 16)                         | 6 (WEB-01, 02, 03, 14, 15, 16) | 8      |
| 2          | 8 (SRV-02, 04, 05, 06, 08, 09, 10, 11) | 10 (WEB-04 do 13)              | 18     |
| 4          | 6 (SRV-03, 07, 12, 13, 14, 15)         | 4 (WEB-17 do 20)               | 10     |
| **Ukupno** | **16**                                 | **20**                         | **36** |

Prvi krug bez čekanja: S-A SRV-01, S-B SRV-05 i W-A WEB-01; S-C kreće sa SRV-16 čim sleti SRV-01. W-B (WEB-08) i W-C (WEB-14) kreću kad sletnu WEB-01, 02 i 03 (WEB-08 još WEB-04 i 06).

**Uska grla:** W-A ima 8 PR-ova u nizu (WEB-01 do 07 i WEB-20), a W-C radi WEB-14 do 16 prije WEB-17 do 19. Uz granicu od 3 WEB pisca web dio vala 4 kreće tek kad W-C završi editor; serverski dio vala 4 ide paralelno.
<!-- VAL-1-2-4-END -->

### Tehničke stavke valova 3 i 5

Lokalna specifikacija preuzeta iz radne dokumentacije. SHA-256 normaliziranog teksta izvornika b8e519d4aa07d28ef18dfdb2281532c7c53206f6964dd73b535c9193e547a93c.

<!-- VAL-3-5-START -->

Datum: 19. 11. 2026. Odobrenje: Daniel 19. 11. 2026. („Može, napravi sve”). Plan: `PLAN-VALOVA.md`. Odgovori: `ODGOVORI-DANIEL-2026-11-19.md`. Inventari: `INVENTAR-editor.md` (E§), `INVENTAR-student.md` (S:), `INVENTAR-nastavnik.md` (N:). Prethodni zadaci: `ZADACI-VAL-1-2-4.md` (SRV-01 do SRV-16, WEB-01 do WEB-20); ovdje se numeriranje nastavlja od SRV-17 i WEB-21.

Val 3: student piše, potvrđuje izjavu, predaje i dobiva potpisanu potvrdu. Val 5: nastavnik vidi studente, mentorstva, zbirni pregled, rad i predaju. Val 3 počinje kad su valovi 1, 2 i 4 gotovi; val 5 kad je serverski dio vala 3 gotov (val 5 ide usporedno s valom 6, koji je samo WEB i UI).

## Zajednička pravila za svaki PR

- PR do oko 300 promijenjenih redaka koda; generirane datoteke ugovora i lockfile se ne broje, ali se navode u opisu.
- **SRV** = `Institution_server`, bazna grana `migracija/kopija-ductus-backend`. **WEB** = `Institution_front_web_chrome`, bazna grana `migracija/kopija-ductus-front`. **UI** = paket `@ductura/ui` (`packages/ui` u WEB-u).
- Novi UI element prvo ide u `packages/ui` (DAN-1111), pa tek onda u stranicu. Stranica ne definira vlastiti gumb, dijalog ni polje.
- Front je Next.js i podatke dobiva samo preko `/api/v1` (klijent `src/client/api.ts`). Svaki PR stranice briše `src/app/api/**` rukovatelje i `withActor` pozive koje je ta stranica koristila.
- Svaka nova tablica ili RPC: RLS, `GRANT` samo potrebnoj ulozi, retci u pgTAP matrici (`db/main/tests/030-institution-access-matrix.sql` ili `103-m2-actor-matrix.sql`) u istom PR-u.
- Samo izmišljeni podaci: izmišljene osobe (`demo-*`, `sim:*`), izmišljeni kolegiji i tekstovi; editor koristi samo `editor/samples/primjer-izmisljeni.json` (nikad `diplomski.json`).
- Prijava je samo AAI@EduHr; lokalno i u CI-ju lažni OIDC (`localhost:8090`). Nema lozinki, magičnih poveznica ni drugih načina prijave.
- Bez tajni u repou, bez primjene migracija na produkciju.
- **Provjera prije SPREMAN** (bez reviewa i QA-a):
  - SRV: `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm build`; uz bazu `pnpm db:up` i `pnpm test:db`;
  - WEB: `pnpm install`, `pnpm typecheck` (skriptu dodaje WEB-01; do tada `tsc --noEmit`), `pnpm test` (node unit + Playwright), `pnpm build`;
  - u opisu PR-a: koraci klikanja iz „Prihvaćanje”.
- Lokalni stog (SRV `pnpm lokalno`): server `:4000`, edge `:8000`, lažni OIDC `:8090`. Putanje označene „(novo)” u kopiji ne postoje; ostale su provjerene `git ls-tree` 19. 11.
- Tekstovi sučelja na hrvatskom, kroz katalog poruka i skener zabranjenih izraza.

### Dodatna pravila za valove 3 i 5

- **Oznaka `kritično`** stoji uz zadatke koji diraju evidenciju, potvrde, kriptografiju, migracije ili prijavu, i uz WEB zadatke koji odlučuju kad se prikazuje „predano”. Kritični PR ide u lokalnu provjeru pojedinačno (pravilo „Testiranje po valu”: kritični PR-ovi i dalje po PR-u).
- **B-6:** poruka o uspjehu (studentu i nastavniku) tek nakon odgovora servera; „predano” tek uz potpisanu potvrdu (`SignedSubmissionReceiptV2`, Ed25519) iz odgovora. Do tada „Šalje se…”. Nikad „spremljeno” bez mjesta.
- **B-8:** kanonski JCS + SHA-256, nepoznata polja se odbijaju (`closed` sheme na serveru, `schema-check` u klijentu), granica veličine i na klijentu i na serveru (`maxBodyBytes` iz ugovora), upis i rezervacija atomski.
- **§5 pravilo 5:** student i nastavnik vide istu potvrdu i isti sažetak procesa, iz iste funkcije na serveru. Nema zasebnog „nastavničkog” oblika potvrde.
- **§5 pravilo 11:** predaju smiju zaustaviti samo nepotvrđena izjava i (ako zadatak to traži) otvorena mjesta za izvor. Lijepljenja, praznine u zapisu i provjera oblika nikad ne blokiraju predaju.
- **§5 pravilo 17:** svako nastavničko čitanje rada, sažetka ili potvrde upisuje se u dnevnik pristupa.
- **Ne gradi se u valovima 3 i 5:** B-1 (Karta podrijetla, „Podrijetlo teksta”, PD-1 odjeljak 11) i B-2 (podudaranje s pomoćnikom, automatsko prilaganje razgovora PD-2, redak „Razgovori uz izjavu”, varijanta E-9 `nesklad`) čekaju promjenu PRODUCT §5 (korak P-1). AI odjeljci ovise o D-194. `/provjera`, QR i PDF su val 9 (C-6). „Zatraži doradu” i stupac „Dorada” s podacima su val 8. Produljenje roka je val 11.
- **Naziv obrasca izjave:** do iznimke u skeneru (P-1, B-5) koristi se neutralan naziv „Izjava”; doslovni naziv službenog obrasca fakulteta ne ulazi u sučelje u ovim valovima.
- **Gumb za otisak:** „Otisak u međuspremnik” (B-4); poruka „Otisak je u međuspremniku (64 znaka, bez razmaka).”

## Trake i vlasništvo zajedničkih datoteka

Najviše 3 pisca u SRV i 3 u WEB istodobno.

| Traka | Repo | Vlasnik zajedničkih datoteka                                                                                                                                                                                                                                                             |
| ----- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-A   | SRV  | `server/contracts/**` (rute, vektori, `generated/`, `openapi/`, `inventory.ts`), lokalni seed                                                                                                                                                                                            |
| S-B   | SRV  | `db/main/migrations/**`, `migrations.sum`, pgTAP matrice; migracije strogo redom                                                                                                                                                                                                         |
| S-C   | SRV  | studentski rukovatelji `server/institution/student-*-route.ts` (novo) i evidence testovi                                                                                                                                                                                                 |
| W-A   | WEB  | Next temelj, `next.config.ts`, `src/client/**` (i podizanje verzije ugovora), `packages/ui/**`, `src/app/ustanova/**`                                                                                                                                                                    |
| W-B   | WEB  | `src/app/zadaci/**`, `src/app/upis/**`, `src/app/prijava/**`, `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/kako-radi`, `src/app/stanje`, `src/app/rad/[assignmentId]/dnevnik-pristupa`, `src/components/student/**`, `src/components/shell/**`, `messages.hr` (samo svoja sekcija) |
| W-C   | WEB  | `src/app/rad/**` (bez `dnevnik-pristupa`), `src/components/editor/**`, zatim `src/app/nastavnik/**`, `src/components/teacher/**`                                                                                                                                                         |

- `server.ts` (montiranje ruta) i lockfile: tko spaja kasnije, rješava konflikt pri rebaseu; generirane datoteke ugovora uvijek se ponovno generiraju (`pnpm contracts:generate`), ne spajaju ručno.
- Trake ne diraju tuđe direktorije. Treba li stranici nova komponenta u `ui`, pisac W-B ili W-C traži je od W-A (zaseban mali UI PR) ili ga sam otvori u `packages/ui` nakon dogovora na koordinacijskom issueu.

### Dopuna tablice za valove 3 i 5

Tablica gore je prepisana iz `ZADACI-VAL-1-2-4.md` bez izmjene. Za ove valove vrijedi dopuna, jer bi se inače studentski tok predaje (stranice u `src/app/rad/**`, komponente u `src/components/student/**`) dijelio između dvije trake:

| Traka | Dodaje se (valovi 3 i 5)                                                                                                                                                                 | Napomena                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| S-C   | ukrcavanje ruta u `server/http/*.ts` za predaju i nastavnička čitanja vala 5 (`server/http/submission.ts`, `teacher-reads.ts`, `live.ts` i nove datoteke u `server/http/`)               | otvoreni PR-ovi #349, #351, #353 drže iste datoteke; S-C radi nakon njihova spajanja |
| W-B   | `src/app/rad/[assignmentId]/predaja/**`, `src/components/predaja/**` (novo), `src/components/student/Submission*`, `SubmissionView.ts`, `TeacherViewSheet*`, `src/components/summary/**` | cijeli tok predaje E-8 do E-11 je jedna traka                                        |
| W-C   | `src/app/rad/[assignmentId]/page.tsx` i okvir radnog prostora E-7 oko editora; u valu 5 `src/app/nastavnik/**`, `src/components/teacher/**`                                              | bez `predaja/**`                                                                     |

## Redoslijed (ovisnosti)

```
Otvoreni SRV PR-ovi (prije vala 3): #348 → #350, #352 → #353 (rub predaje, nije ukrcan)
#346 → #347 → #349 (nastavnička čitanja) → #351 (live.document) → #353
SRV-07 (val 4) → SRV-20 → SRV-21 → SRV-28   (migracije redom, traka S-B)
SRV-18 h-predaja → SRV-17 seed-predaja (skripta ide kroz pravu predaju); SRV-18 → SRV-22, SRV-23, SRV-24
SRV-19 ugovori-predaja → SRV-25 izdanje 3.1.0 → WEB-22 klijent → WEB-24..27
SRV-26 seed-nastavnik, SRV-27 ugovori-nastavnik → SRV-32 izdanje 3.2.0 → WEB-30 klijent → WEB-31..35
WEB-21 ui-koraci-otisak → WEB-24..27;  WEB-29 ui-tablica-oznaka → WEB-31..33;  WEB-34 → WEB-35 → WEB-36
```

---

## Val 3: predaja studenta (17 PR-ova)

### SRV-17 `seed-predaja` · SRV · traka S-A

- **Datoteke:** `scripts/lokalno/seed-predaja.ts` (novo), `scripts/lokalno/config.ts` (naredba), `db/main/local/seed.sql` (samo zadatak s rokom u prošlosti), README odjeljak „Lokalni računi”.
- **Gradi:** potpisana potvrda ne smije se upisati ručno u bazu, pa skripta nakon `pnpm lokalno` prolazi stvarni put preko `/api/v1` s lažnim OIDC-om. Računi iz SRV-01 ostaju kakvi jesu (WEB-09 treba prazno stanje za `demo-student-2`, WEB-18 njegov upis novim kodom); za predaje se dodaju novi izmišljeni računi u datoteku lažnih OIDC računa:
  - `demo-student`: rad na zadatku „Seminarski rad: kućno kompostiranje” ostaje otvoren i nepredan (za E-7 do E-10);
  - `demo-student-3` (novo): upisan u isti kolegij, potvrdio obavijest, piše tekst iz `primjer-izmisljeni.json`, predaje (200 s potvrdom);
  - `demo-student-4` (novo): treći izmišljeni kolegij „Izmišljeni seminar iz urbane hidrologije” sa zadatkom „Kratki osvrt: gradski vrtovi” s rokom u prošlosti (u `seed.sql`; postojeći kolegij bez zadatka se ne dira); predaje nakon roka (`afterDeadline: true`);
  - skripta je idempotentna: drugi pokret ne stvara novu predaju (ponovna predaja iste revizije vraća istu potvrdu).
- **Prihvaćanje:** `pnpm lokalno` pa `pnpm lokalno:predaje` → `GET /api/v1/student/assignment-work` kao `demo-student-3` vraća `submitted`; `demo-student-2` i dalje nema kolegij; drugi pokret skripte ne mijenja ništa.
- **Ovisi o:** SRV-01, SRV-18. Rad s prazninom u zapisu: vidi Otvorena pitanja (P-3).

### SRV-18 `h-predaja` · SRV · traka S-C · **kritično**

- **Datoteke:** `server/http/submission.ts` (iz #353), `server/http/index.ts` (montiranje), `server/contracts/inventory.ts` (makni `submission.submit.post` iz `CONTRACT_ONLY`; vlasnik S-A, pisac traži jednoredni dogovor), `server/http/submission.integration.test.ts` (novo).
- **Gradi:** ukrcati `submission.submit.post` (`POST /api/v1/submission`) nad `server/evidence/submission.ts` kad postane učitljiv (nakon #348 i #352); rub iz #353 (tijelo točno `{documentId, revision}`, do 1 KiB, zatvorena mapa ishoda) se ne mijenja. Vrijeme je sat baze; od klijenta ne dolazi vrijeme, tekst ni hash.
- **Prihvaćanje (integracijski testovi na lokalnoj bazi):**
  - predaja → 200 `{status:"submitted", receipt}`; potpis provjerljiv javnim ključem iz `server/database/receipt-keys.ts`; `payloadDigestSha256` = SHA-256 JCS-a `payload`;
  - ista revizija ponovno → isti bajtovi potvrde; druga revizija → 409 `already_requested`;
  - nepotvrđena obavijest → 409 `not_acknowledged`; tuđi rad → 404; nepoznato polje u tijelu → 422; tijelo veće od 1 KiB → 413;
  - potpisivač nedostupan → 503 `signing` s `retry-after: 5`; ista revizija nakon oporavka → 200 i potvrda se veže jednom;
  - rad s lijepljenjem i s prazninom u zapisu (vektor iz testova evidencije) → 200 (pravilo 11).
- **Ovisi o:** #348, #350, #352, #353 (spojeni), SRV-01.

### SRV-19 `ugovori-predaja` · SRV · traka S-A

- **Datoteke:** `server/contracts/routes/student.ts`, `server/contracts/routes/index.ts`, `server/contracts/vectors/*.json`, `server/contracts/generated/*`, `server/contracts/inventory.ts`.
- **Gradi:** samo nove rute (novi član zatvorenog tijela je glavno izdanje, komentar u `student.ts`):
  - `student.submission.get` `GET /api/v1/student/assignments/{assignmentId}/submission` → `{state:"none"}` | `{state:"ceka", revision, requestedAt}` | `{state:"potvrdeno", receipt}` (receipt = isti `SignedSubmissionReceiptV2` kao u `evidence.ts`, izvesti ga iz jednog mjesta). „ceka” znači: predaja je upisana, potvrda još nije vezana (503 `signing` u SRV-18);
  - `student.assignment-requirements.get` `GET /api/v1/student/assignments/{assignmentId}/requirements` → `{wordRange: {min, max} | null}` (PO-12; podatak postoji u `20261022090000_assignment_word_range.sql`);
  - `student.submission-notes.get` i `student.submission-notes.post` (C-5, PD-4): tijelo `{assignmentId, text}`, `text` 1 do 600 znakova, samo dodavanje;
  - izjava (C-3): **nema rute u ovom valu** (vidi P-7); potvrda izjave u valu 3 živi samo u toku predaje u pregledniku i ne šalje se serveru (PO-17: izjava i napomene ne idu u predaju);
  - JCS vektori za sve oblike; `contracts:breaking` mora reći „minor”.
- **Prihvaćanje:** `pnpm contracts:generate` bez razlike nakon commita; vektori zeleni; `contracts:breaking` bez glavnog izdanja.
- **Ovisi o:** SRV-04 (izdanje 3.0.0 već objavljeno).

### SRV-20 `mig-predaja-citanje` · SRV · traka S-B · **kritično**

- **Datoteke:** nova migracija, `migrations.sum`, `db/main/tests/067-submission-receipt.sql` (proširiti), `db/main/tests/030-institution-access-matrix.sql`.
- **Gradi:** `evidence.submission_receipt` nema dozvolu za web ulogu, a `app.read_submission_receipt(p_submission_id)` čita samo po id-ju predaje i samo za pozivatelja. Dodaje se:
  - `app.submission_state_of(p_assignment_id, p_student_id)`: čisti čitač bez nuspojava (vraća `none` | `ceka` | `potvrdeno` s potvrdom), bez dozvole za web ulogu; jedini izvor oblika za oba čitatelja (pravilo 5);
  - `app.my_submission_state(p_assignment_id)` (SECURITY DEFINER, `GRANT` web ulozi): student samo za sebe, bez upisa u dnevnik;
  - `app.teacher_submission_state(p_assignment_id, p_student_id)` (SECURITY DEFINER, `GRANT` web ulozi): nastavnik ili suradnik kolegija (C-7) za studenta svog kolegija; u istoj transakciji upisuje redak dnevnika pristupa (pravilo 17; površina: P-5); ostali dobivaju isto što i nepostojeći zadatak;
  - `app.my_assignment_requirements(p_assignment_id)`: raspon riječi za upisanog studenta.
- **Prihvaćanje:** pgTAP: student svoj da, tuđi ne; nastavnik kolegija da; suradnik da; nastavnik drugog kolegija ne; uklonjeni student ne; `app.teacher_submission_state` ostavlja redak u dnevniku, `app.my_submission_state` ne; web uloga ne može zvati `app.submission_state_of`.
- **Ovisi o:** SRV-07 (redoslijed migracija).

### SRV-21 `mig-napomene` · SRV · traka S-B · **kritično**

- **Datoteke:** nova migracija, `migrations.sum`, `db/main/tests/` (nova datoteka napomena), matrica pristupa.
- **Gradi:** tablica `evidence.submission_note (id, assignment_id, student_id, text, created_at)` samo za dodavanje (okidač `audit.reject_change` na UPDATE i DELETE, kao u `mentorship_request`), `text` 1 do 600 znakova; RLS: student dodaje i čita svoje, nastavnik i suradnik kolegija čitaju; RPC `app.add_submission_note`, `app.submission_notes`. Napomena nije dio sažetka procesa ni potvrde.
- **Prihvaćanje:** pgTAP matrica: student da, drugi student ne, nastavnik kolegija čita, nastavnik drugog kolegija ne; UPDATE i DELETE padaju; 601 znak pada.
- **Ovisi o:** SRV-20.

### SRV-22 `h-predaja-stanje` · SRV · traka S-C · **kritično**

- **Datoteke:** `server/institution/student-submission-route.ts` (novo), `server/institution/student-requirements-route.ts` (novo), montiranje, testovi.
- **Gradi:** rukovatelji `student.submission.get` i `student.assignment-requirements.get` nad SRV-20; nepoznat, tuđi i neispravan id daju isti 404; red koji čitanje ne može potvrditi → 503, nikad djelomičan odgovor.
- **Prihvaćanje:** `demo-student-3` → `potvrdeno` s istim bajtovima potvrde kao iz predaje; `demo-student` → `none`; s isključenim potpisivačem predaja → 503, zatim `ceka`; nakon ponovne predaje iste revizije `potvrdeno`.
- **Ovisi o:** SRV-18, SRV-19, SRV-20.

### SRV-23 `h-sazetak-procesa` · SRV · traka S-C · **kritično**

- **Datoteke:** `server/http/process-summary.ts` (novo), nad `server/projection/process-summary-reader.ts`; `inventory.ts` (makni iz `CONTRACT_ONLY`).
- **Gradi:** ukrcati `projection.process-summary.post` (tijelo točno `{documentId}`, do 1 KiB); isti JCS bajtovi za studenta i nastavnika (pravilo 5); nastavničko čitanje upisuje dnevnik pristupa s površinom `process_summary`. Oblik `ProcessSummaryV1` se ne mijenja.
- **Prihvaćanje:** kao `demo-student-3` i kao `demo-teacher` isti bajtovi odgovora; `demo-student` za tuđi rad → 404; nakon nastavničkog čitanja `student.access-log.get` pokazuje redak `process_summary`.
- **Ovisi o:** SRV-18, SRV-11.

### SRV-24 `h-napomene` · SRV · traka S-C

- **Datoteke:** `server/institution/student-notes-route.ts` (novo), montiranje, testovi.
- **Gradi:** rukovatelji `student.submission-notes.get` i `.post` nad SRV-21; prazan tekst → 422.
- **Prihvaćanje:** `demo-student` doda napomenu, vidi je nakon osvježavanja; ne može je izmijeniti ni obrisati; 601 znak → 422.
- **Ovisi o:** SRV-19, SRV-21.

### SRV-25 `ugovori-izdanje-3-1` · SRV · traka S-A

- **Gradi:** `pnpm release:tarball` za `@ductura/contracts` 3.1.0 (manje izdanje) s rutama iz SRV-19, tarball u Releases.
- **Prihvaćanje:** tarball se instalira u čistom direktoriju; vektori izjave dostupni lažnom serveru.
- **Ovisi o:** SRV-19.

### WEB-21 `ui-koraci-otisak` · UI · traka W-A

- **Datoteke:** `packages/ui/src/steps/**`, `packages/ui/src/fingerprint/**`, `packages/ui/src/key-value/**` (novo).
- **Gradi:** `Steps` (`ol` s `aria-current="step"`, 5 koraka: 1 Tekst, 2 Izjava, 3 Prije predaje, 4 Predaja, 5 Potvrda); `Fingerprint` (64 heksadecimalna znaka u skupinama po 4, gumb „Otisak u međuspremnik”, u međuspremnik ide 64 znaka bez razmaka, `Toast` „Otisak je u međuspremniku (64 znaka, bez razmaka).”); `KeyValueList` (`dl`, s mjestom za UTC pojedinosti u `details`).
- **Prihvaćanje:** `/ui-pregled` u obje teme; čitač zaslona čita trenutni korak; otisak u međuspremniku nema razmaka; axe bez nalaza.
- **Ovisi o:** WEB-04, WEB-05.

### WEB-22 `klijent-predaja` · WEB · traka W-A · **kritično**

- **Datoteke:** `src/client/submission.ts` (novo), `src/client/submission.test.ts` (novo), `src/client/package.json` (ugovori 3.1.0; ondje je verzija `@ductura/contracts`).
- **Gradi:** podizanje `@ductura/contracts` na 3.1.0; čitači `student.submission.get`, `student.assignment-requirements.get` i napomena; predaja `submission.submit.post` sa zatvorenom mapom ishoda prema S: PO-17: 200 → `predano` samo ako potvrda prođe `schema-check`; 409 `blocked` → `odbijeno` (s razlogom), osim `record_mismatch` → `nedovrseno`; 408 i 503 → `nepoznato` (nikad „nije predano”); 409 `already_requested` → čitanje stanja; 401 → postojeći tok isteka sesije (`session-expired`). Ishodi koje inventar ne preslikava (`stale_revision`, `not_acknowledged`, `not_open`, 404, 413, 426): prijedlog `greska` s vlastitim tekstom, konačno prema P-10. Svaki nepoznat oblik → `nepoznato`.
- **Prihvaćanje:** jedinični testovi za svaki ishod iz vektora; potvrda s dodatnim poljem → `nepoznato`, ne `predano`.
- **Ovisi o:** SRV-25, WEB-07.

### WEB-23 `student-radni-prostor` · WEB · traka W-C

- **Datoteke:** `src/app/rad/[assignmentId]/page.tsx` (iz WEB-14), `src/components/editor/WorkspaceTopBar.tsx` (novo), `src/components/editor/StatusBar.tsx` (iz WEB-14).
- **Gradi:** S: E-7 okvir oko editora: gornja traka „← Moji zadaci”, naslov, prekidač lista „Bijeli list/Tamni list”, gumb „Predaja rada” → `/rad/[assignmentId]/predaja`; statusna traka: stanje spremanja i broj riječi uz raspon („opseg 1.200 do 1.600 · vidite samo Vi”, napomene se ne broje); varijante puno, prazno, ucitavanje, greska, bez-mreze, predano (nakon predaje list samo za čitanje, stanje iz `student.submission.get`).
- **Prihvaćanje:** `demo-student` vidi raspon iz zadatka i broj riječi koji raste dok piše; mreža isključena → „Predaja rada” onemogućen s objašnjenjem; `demo-student-3` vidi predani rad samo za čitanje.
- **Ovisi o:** WEB-15, WEB-22, SRV-22.

### WEB-24 `student-izjava` · WEB · traka W-B

- **Datoteke:** `src/app/rad/[assignmentId]/predaja/izjava/page.tsx` (novo), `src/components/predaja/Declaration.tsx` (novo).
- **Gradi:** S: E-9 (C-3), naziv „Izjava”: blokovi „Zabilježeno u Ducturi” (iz sažetka procesa, stvarni server), „Vaša izjava”; kvačica „Potvrđujem izjavu” otključava „Dalje”; potvrda živi samo u toku predaje u pregledniku (ne šalje se serveru, P-7); varijante puno, prazno, ucitavanje, greska. **Ne gradi se:** varijanta `nesklad`, blok Prilozi s razgovorima (PD-2), sve iz B-2; „Pitanje nastavnika” s odgovorom čeka P-7 (nema gdje upisati odgovor).
- **Putanje** `predaja/izjava`, `predaja/pregled`, `predaja/slanje`, `predaja/potvrda` (ovdje i u WEB-25 do 27) su prijedlog: inventar ima jednu stranicu predaje i korake 1–5, ne URL-ove; pisac smije zadržati jednu stranicu s koracima ako je manje promjena.
- **Prihvaćanje:** bez kvačice „Dalje” je onemogućen; s kvačicom vodi na korak 3; korak 2 je `aria-current`; nakon povratka s koraka 3 kvačica ostaje.
- **Ovisi o:** WEB-21, WEB-22, SRV-23 (blok „Zabilježeno u Ducturi”).

### WEB-25 `student-prije-predaje` · WEB · traka W-B

- **Datoteke:** `src/app/rad/[assignmentId]/predaja/pregled/page.tsx` (novo), `src/components/predaja/BeforeSubmit.tsx`, `NoteDialog.tsx` (novo); `src/components/summary/ProcessSummaryView.tsx` (postoji).
- **Gradi:** S: E-8 s koracima i redovima provjere: Izjava, Mjesta za izvor, Zalijepljeno (izvor nije opažen), Pravila oblika („Provjera oblika još nije pokrenuta.”, bez funkcije, C-19); „Dodaj napomenu (nije obavezna)” → PD-4 (do 600 znakova, samo dodavanje, prazno → `aria-invalid`); desni stupac PD-1 samo s odjeljcima koje `ProcessSummaryV1` ima (sesije, lijepljenja, praznine u zapisu, stanje zapisa). Varijante puno, zatvoreno, bezmreze, predano, prazno, ucitavanje, greska. **Ne gradi se:** redak „Razgovori uz izjavu” (B-2), Karta podrijetla (B-1), AI odjeljak (D-194).
- **Prihvaćanje:** rad s lijepljenjem i prazninom u zapisu može dalje na korak 4 (pravilo 11); nepotvrđena izjava vraća na korak 2; napomena se doda i ostaje nakon osvježavanja.
- **Ovisi o:** WEB-24, SRV-23, SRV-24.

### WEB-26 `student-predaja` · WEB · traka W-B · **kritično**

- **Datoteke:** `src/app/rad/[assignmentId]/predaja/slanje/page.tsx` (novo), `src/app/rad/[assignmentId]/predaja/page.tsx` (postoji; postaje preusmjerenje na korak prema `student.submission.get`), `src/components/student/Submission.tsx` i `SubmissionView.ts` (postoje, prebačeni na `/api/v1`), `src/components/predaja/SubmitDialog.tsx` (novo).
- **Gradi:** S: E-10 i PD-3 „Predati rad?” (dok šalje, gumbi onemogućeni, Esc ne zatvara); varijante puno, nakonroka (rok iz `student.assignments.get`), produljen (A-3), bezmreze, utijeku („Šalje se…”), odbijeno, nedovrseno, nepoznato („Provjeri stanje predaje” čita `student.submission.get`, R-38), ucitavanje, greska. Šalje se samo revizija koju student vidi; uspjeh tek s potvrdom (WEB-22). Briše `withActor` datoteke stare stranice predaje.
- **Prihvaćanje:** `demo-student` predaje → korak 5; isključen potpisivač → „nepoznato”, „Provjeri stanje predaje” → `ceka`; dvostruki klik šalje jedan zahtjev; rok prošao → varijanta nakonroka prije slanja.
- **Veličina:** ako PR prijeđe oko 300 redaka, prvo ide PD-3 i preusmjerenje, zatim varijante ishoda.
- **Ovisi o:** WEB-25, SRV-22.

### WEB-27 `student-potvrda` · WEB · traka W-B · **kritično**

- **Datoteke:** `src/app/rad/[assignmentId]/predaja/potvrda/page.tsx` (novo), `src/components/predaja/ReceiptPanel.tsx` (novo; jedini dom komponente, W-C ga u valu 5 uvozi bez izmjene, a promjene idu preko W-B).
- **Gradi:** S: E-11 iz `student.submission.get`: vrijeme predaje, rok, „Potpisivanje započelo”, verzija zadatka (C-11), pojedinosti u UTC (`requestedAt`, `dueAt`, `signedAt`), otisak (`artifactSha256`) kroz `Fingerprint`, stanje zapisa (`continuous` | `with_gaps`), poveznica na sažetak (PD-1); tekst B-3 „Kod potvrđuje da se predani tekst nije mijenjao od predaje.” Varijante puno, ceka, nakonroka, praznine, prazno, ucitavanje, greska. Vrijeme u zoni Europe/Zagreb (`zagreb-time.ts`). **Ne gradi se:** `/provjera`, QR, PDF (val 9).
- **Prihvaćanje:** nakon predaje i osvježavanja ista potvrda (isti otisak); otisak u međuspremniku 64 znaka; predaja nakon roka pokazuje varijantu nakonroka; `ceka` ne kaže „predano”.
- **Ovisi o:** WEB-21, WEB-26.

### WEB-28 `predaja-e2e` · WEB · traka W-B

- **Datoteke:** `e2e/predaja-val3.spec.js` (novo).
- **Gradi:** Playwright tok na lokalnom stogu: prijava `demo-student` → rad → izjava → prije predaje (uz napomenu) → predaja → potvrda → osvježavanje; uz axe na 1250 i 400 px; slučaj s isključenom mrežom na koraku 4.
- **Prihvaćanje:** `pnpm test:functional` zelen lokalno.
- **Ovisi o:** WEB-23, WEB-27, SRV-17.

**Kraj vala 3:** Daniel na lokalnom stogu kao `demo-student` napiše tekst, potvrdi izjavu, preda i vidi potvrdu s otiskom; nakon osvježavanja potvrda je ista.

---

## Val 5: nastavnik vidi predaju (15 PR-ova)

Već u tijeku (ne duplicirati): #346 (`institution.student-removal.post`, `student-return.post`, `assignment-versions.post`; preklapa se s rukovateljem iz SRV-14, pisac SRV-14 prvo provjeri #346), #349 (`teacher.courses.get`, `teacher.mentorships.get`, `teacher.mentorship.get`, `teacher.submissions.get`, `teacher.assignment-submissions.post`; preklapa se sa SRV-13 za `teacher.courses.get`), #351 (`live.document.get` i `.put`, nastavničko čitanje već upisuje dnevnik pristupa).

### SRV-26 `seed-nastavnik` · SRV · traka S-A

- **Datoteke:** `db/main/local/seed.sql`, `scripts/lokalno/seed-predaja.ts` (iz SRV-17).
- **Gradi:** novi izmišljeni račun `demo-student-5` šalje zahtjev za mentorstvo prema `demo-teacher` kroz `institution.request_mentorship` (završni rad, izmišljen naslov); funkcija čita pozivatelja iz sesije, pa poziv ide kroz skriptu (kao predaje u SRV-17), ne kroz čisti `seed.sql`; pisac provjeri koji lokalni put postavlja sesiju studenta. U kolegiju seeda `demo-student` je u grupi A, `demo-student-3` u grupi B; `demo-student-2` se ne dira.
- **Prihvaćanje:** `teacher.mentorships.get` kao `demo-teacher` pokazuje zahtjev; kolegij ima studente u obje grupe; prazno stanje `demo-student-2` iz WEB-09 i dalje vrijedi.
- **Ovisi o:** SRV-17, #349.

### SRV-27 `ugovori-nastavnik-predaje` · SRV · traka S-A

- **Datoteke:** `server/contracts/routes/teacher.ts`, vektori, `generated/*`, `inventory.ts`.
- **Gradi:** samo nove rute:
  - `teacher.course-students.get` `GET /api/v1/teacher/courses/{courseId}/students` (N-04): ime i prezime (ili `null`, nikad zamjena), grupa, stanje rada po zadatku; nad `app.teacher_course_students` (postoji, `20261028140000_teacher_rosters.sql`);
  - `teacher.assignment-overview.get` `GET /api/v1/teacher/assignments/{assignmentId}/overview` (N-17): po studentu ime, grupa, `submitted`, `requestedMinute`, `afterDeadline` (već u `Submitted`) i `evidenceRecord` iz potvrde (`continuous` | `with_gaps` | `null` dok je `ceka`); bez teksta, hasha i id-ja predaje;
  - `teacher.submission-receipt.get` `GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/submission`: isto tijelo kao `student.submission.get` (isti tip, pravilo 5);
  - `teacher.mentorship-requests.get` i `teacher.mentorship-request-decision.post` (tijelo `{requestId, decision: "approve" | "decline", reason?}`, `reason` samo uz `decline`; gornja granica duljine je prijedlog 600 kao PD-4, inventar je ne navodi).
- **Prihvaćanje:** `contracts:generate` bez razlike; vektori zeleni; `contracts:breaking` bez glavnog izdanja.
- **Ovisi o:** SRV-25.

### SRV-28 `mig-nastavnik-predaje` · SRV · traka S-B · **kritično**

- **Datoteke:** nova migracija, `migrations.sum`, `db/main/tests/104-mentorship-request.sql`, `090-teacher-rosters.sql`, `086-assignment-submissions.sql` (proširiti), matrica pristupa.
- **Gradi:**
  - `institution.decline_mentorship_request(p_request_id, p_reason)` (novo; postoje samo `request_`, `withdraw_` i `approve_mentorship_request`), događaj u `audit.mentorship_event`;
  - `app.assignment_overview(p_assignment_id)`: spaja `app.assignment_submissions` s imenima iz popisa kolegija i stanjem zapisa iz čistog čitača `app.submission_state_of` (SRV-20); ne upisuje redak dnevnika po studentu (zbirni pregled ne otvara rad);
  - provjera da `app.teacher_course_students` i `app.assignment_submissions` puštaju suradnika (C-7); ako ne, ispravak u istoj migraciji.
- **Prihvaćanje:** pgTAP: nositelj i suradnik da, nastavnik drugog kolegija ne, student ne; odbijanje tuđeg zahtjeva ne; odbijen zahtjev se ne može odobriti.
- **Ovisi o:** SRV-21 (redoslijed migracija).

### SRV-29 `h-studenti-zbirni` · SRV · traka S-C

- **Datoteke:** `server/http/teacher-roster.ts` (novo), montiranje, testovi; `server/institution/course-students.ts` (postoji).
- **Gradi:** rukovatelji `teacher.course-students.get` i `teacher.assignment-overview.get`; tuđi, nepoznat i neispravan id daju isti odgovor kao prazan (kao `teacher.submissions.get`).
- **Prihvaćanje:** `demo-teacher` i `demo-teacher-2` vide studente kolegija u dvije grupe; zbirni pokazuje `demo-student-3` predano i `demo-student` nepredano; zbirni zadatka iz kolegija urbane hidrologije (nastavnik iz seeda tog kolegija) pokazuje `demo-student-4` nakon roka; otvaranje zbirnog ne dodaje retke u dnevnik pristupa.
- **Ovisi o:** SRV-27, SRV-28, #349.

### SRV-30 `h-potvrda-nastavnik` · SRV · traka S-C · **kritično**

- **Datoteke:** `server/http/teacher-submission-receipt.ts` (novo), montiranje, testovi.
- **Gradi:** rukovatelj `teacher.submission-receipt.get` nad `app.teacher_submission_state` (isti čisti čitač kao studentski, SRV-20); čitanje upisuje dnevnik pristupa.
- **Prihvaćanje:** bajtovi potvrde za `demo-teacher` jednaki onima koje vidi `demo-student-3`; nakon čitanja student u dnevniku pristupa vidi novi redak; nastavnik drugog kolegija → 404.
- **Ovisi o:** SRV-22, SRV-27.

### SRV-31 `h-mentorstva-zahtjevi` · SRV · traka S-C

- **Datoteke:** `server/http/teacher-mentorship-requests.ts` (novo), montiranje, testovi.
- **Gradi:** rukovatelji `teacher.mentorship-requests.get` i `teacher.mentorship-request-decision.post` nad `approve_mentorship_request` i SRV-28; odgovor tek nakon upisa u bazu.
- **Prihvaćanje:** `demo-teacher` odobri zahtjev → mentorstvo se pojavi u `teacher.mentorships.get`; odbijanje s razlogom → zahtjev nestaje s popisa; ponovna odluka → 409.
- **Ovisi o:** SRV-26, SRV-27, SRV-28.

### SRV-32 `ugovori-izdanje-3-2` · SRV · traka S-A

- **Gradi:** `@ductura/contracts` 3.2.0 (manje izdanje) s rutama iz SRV-27, tarball u Releases.
- **Prihvaćanje:** tarball se instalira u čistom direktoriju.
- **Ovisi o:** SRV-27.

### WEB-29 `ui-tablica-oznaka` · UI · traka W-A

- **Datoteke:** `packages/ui/src/table/**`, `packages/ui/src/state-tag/**` (novo).
- **Gradi:** `DataTable` (`caption`, zaglavlja s `scope`, sortiranje tipkovnicom, prazno stanje, skeleton); `StateTag` (oznaka stanja: tekst uvijek uz boju, nikad samo boja; stanja predano, nije predano, nakon roka, čeka potvrdu, praznina u zapisu).
- **Prihvaćanje:** `/ui-pregled` u obje teme i na 400 px; axe bez nalaza; čitač zaslona čita zaglavlje uz ćeliju.
- **Ovisi o:** WEB-05.

### WEB-30 `klijent-nastavnik-predaje` · WEB · traka W-A

- **Datoteke:** `src/client/teacher-reads.ts` (novo; postoji samo `teacher-reads.test.ts`, proširiti ga), `src/client/mentorship-requests.ts` (novo), `src/client/package.json` (ugovori 3.2.0).
- **Gradi:** podizanje na 3.2.0; čitači ruta iz SRV-27 i odluka o mentorstvu; potvrda za nastavnika prolazi isti `schema-check` kao studentska (WEB-22).
- **Prihvaćanje:** jedinični testovi iz vektora; nepoznato polje → greška, ne prikaz.
- **Ovisi o:** SRV-32, WEB-22.

### WEB-31 `nastavnik-studenti` · WEB · traka W-C

- **Datoteke:** `src/app/nastavnik/kolegiji/[courseId]/studenti/page.tsx` (novo), `src/components/teacher/CourseStudents.tsx` (novo).
- **Gradi:** N: N-04 s filtrom grupe (`#f-gr` s brojevima), redak „ime · grupa”, podredak stanja, „Otvori seminarski rad”; varijante puno, prazno, ucitavanje, greska. Varijanta `dorada` čeka val 8.
- **Prihvaćanje:** `demo-teacher` i `demo-teacher-2` vide studente kolegija; filtar grupe B pokazuje samo `demo-student-3`; „Otvori seminarski rad” vodi na N-06.
- **Ovisi o:** WEB-29, WEB-30, SRV-29, WEB-18.

### WEB-32 `nastavnik-mentorstva` · WEB · traka W-C

- **Datoteke:** `src/app/nastavnik/mentorstva/page.tsx` (postoji), `src/components/teacher/MentoredWorks.tsx` (postoji), `src/components/teacher/MentorshipRequests.tsx` (novo).
- **Gradi:** N: N-16 popis mentorstava i kartica „Zahtjevi za mentorstvo” s „Odobri” i „Odbij”; „Odbij” otvara dijalog `do-h` s neobveznim razlogom (`#f-ro`, do 600 znakova); poruka tek nakon odgovora servera (B-6). Briše `withActor` datoteke stranice.
- **Prihvaćanje:** `demo-teacher` odobri zahtjev iz seeda → rad se pojavi u popisu; odbijanje uz razlog → zahtjev nestane; s isključenim serverom poruka o uspjehu se ne pojavi.
- **Ovisi o:** WEB-30, SRV-31.

### WEB-33 `nastavnik-zbirni` · WEB · traka W-C

- **Datoteke:** `src/app/nastavnik/zbirni/page.tsx` (iz WEB-17, prazno stanje), `src/components/teacher/AssignmentOverview.tsx` (novo).
- **Gradi:** N: N-17 tablica: Student, Stanje, Vrijeme predaje (minuta, Europe/Zagreb), Nakon roka, Stanje zapisa, Dorada (stupac prazan do vala 8); odabir zadatka; redak vodi na N-07.
- **Prihvaćanje:** zbirni za zadatak iz seeda pokazuje predano, nakon roka i nepredano; sortiranje po vremenu predaje radi tipkovnicom.
- **Ovisi o:** WEB-29, WEB-30, SRV-29, WEB-17.

### WEB-34 `nastavnik-rad-uzivo` · WEB · traka W-C

- **Datoteke:** `src/app/nastavnik/rad/[id]/page.tsx` (postoji), `src/components/teacher/LiveWorkView.tsx`, `LiveText.tsx`, `SummaryCard.tsx` (postoje).
- **Gradi:** N: N-06 rad uživo samo za čitanje (`live.document.get`, #351), zaglavlje, poveznice, prethodni i sljedeći rad; traka o prazninama u zapisu kad sažetak kaže `has_gaps` (C-18), s poveznicom na sažetak; traka „nije predano” bez poveznice na produljenje (val 11); poveznica na N-07 kad je rad predan. **Ne gradi se:** „Zatraži doradu” (val 8).
- **Prihvaćanje:** `demo-teacher` otvori rad `demo-student` i vidi tekst koji student piše; student nakon toga u dnevniku pristupa vidi otvaranje (površina `live_view`, #351).
- **Ovisi o:** WEB-30, SRV-23, #351.

### WEB-35 `nastavnik-predaja` · WEB · traka W-C · **kritično**

- **Datoteke:** `src/app/nastavnik/rad/[id]/predaja/page.tsx` (novo); `ReceiptPanel` iz WEB-27 uvozi se bez izmjene.
- **Gradi:** N: N-07 potvrda iz `teacher.submission-receipt.get`, ista komponenta i isti tekst kao kod studenta; varijante ceka i nedovrseno; potvrda se nikad ne prikazuje bez potpisane potvrde. **Ne gradi se:** blok izjave (`declPanel`, ne prikazuje se), QR i poveznica za provjeru (val 9).
- **Prihvaćanje:** `demo-teacher` otvori predaju `demo-student-3` i vidi isti otisak kao student; redak u dnevniku pristupa studenta provjerava se tek kad P-5 odluči površinu.
- **Ovisi o:** WEB-27, WEB-30, WEB-34, SRV-30.

### WEB-36 `nastavnik-e2e` · WEB · traka W-C

- **Datoteke:** `e2e/nastavnik-val5.spec.js` (novo).
- **Gradi:** Playwright: `demo-teacher` → studenti → rad → predaja; zbirni; mentorstva (odobri zahtjev `demo-student-5`); zatim `demo-student-3` vidi isti otisak i retke u dnevniku pristupa; axe na 1250 i 400 px.
- **Prihvaćanje:** `pnpm test:functional` zelen lokalno.
- **Ovisi o:** WEB-31 do WEB-35, SRV-26.

**Kraj vala 5:** Daniel kao `demo-teacher` vidi studente po grupama, zbirni pregled, rad uživo i predaju s istim otiskom koji vidi student, i odobri zahtjev za mentorstvo.

---

## Otvorena pitanja

Do odgovora se navedeno ne gradi; zadatak gradi ostatak.

- **P-1 Pravila predaje zadatka.** Gdje piše traži li zadatak potvrdu izjave i popunjena mjesta za izvor (pravilo 11, uvjetno do pisane potvrde FPZG-a, C-42)? U shemi nije nađeno polje. Do odgovora redovi Izjava i Mjesta za izvor u E-8 samo informiraju, osim kvačice izjave koja vodi tok (C-3). **Blokira:** strogu provjeru u WEB-25 (ostalo se gradi).
- **P-2 PD-1 izvan `ProcessSummaryV1`.** Aktivno vrijeme, broj verzija i napomene u sažetku: proširenje sažetka mijenja isti prikaz i za nastavnika (pravilo 5), a aktivno vrijeme je mjera iz vremena (pravilo 4). Grade se samo postojeći odjeljci dok vlasnik ne odluči. **Blokira:** dodatne odjeljke u WEB-25 i SRV-23.
- **P-3 Rad s prazninom u zapisu u seedu.** Praznina nastaje iz prekinutog zapisa; ne smije se krivotvoriti upisom u bazu. Ako je javni API ne može proizvesti, varijante „praznine” (E-11, N-06, N-17) provjeravaju se samo jediničnim testovima s izmišljenim vektorom. Treba li za to lokalna naredba koja namjerno prekida zapis? **Blokira:** samo e2e provjeru praznina u WEB-28 i WEB-36.
- **P-4 Provjera potpisa u pregledniku.** Provjerava li web Ed25519 potpis potvrde predaje (i odakle javni ključ), ili je dovoljna provjera oblika iz `schema-check` i provjera na `/provjera` u valu 9? **Blokira:** ništa; WEB-22 i WEB-27 grade provjeru oblika, potpis se dodaje ako odgovor bude da.
- **P-5 Površina u dnevniku pristupa za čitanje potvrde.** `student.access-log.get` ima zatvoren popis površina (`live_view`, `process_summary`, `fast_path`, `replay`, `submitted_text`). Ide li čitanje potvrde pod `submitted_text` ili nova vrijednost (tada nova ruta ili glavno izdanje)? **Blokira:** upis u dnevnik u SRV-20 (`app.teacher_submission_state`) i SRV-30 te taj dio prihvaćanja u WEB-35 i WEB-36.
- **P-6 Razlog odbijanja mentorstva.** Vidi li student razlog iz dijaloga `do-h`? Do odgovora razlog se upisuje samo u `audit.mentorship_event` i studentu se ne prikazuje. **Blokira:** studentski prikaz razloga (nije u ovim valovima).
- **P-7 Trajni zapis izjave (C-3, D-194).** Upisuje li se studentova potvrda izjave na server (nova tablica s RLS-om i pgTAP retcima, ugovor `student.declaration.*`) i gdje se čuva odgovor na „Pitanje nastavnika”? C-3 dopušta izjavu prije D-194, ali oblik čuvanja nije odlučen. Do odgovora potvrda živi samo u toku predaje u pregledniku, a „Pitanje nastavnika” se ne gradi. **Blokira:** spremanje izjave i odgovor na pitanje nastavnika (WEB-24 gradi ostatak).
- **P-8 Uklanjanje i vraćanje studenta na N-04.** Rukovatelji su u #346, ali N-04 u inventaru nema radnju uklanjanja. Gradi li se u valu 5 ili kasnije? **Blokira:** radnju uklanjanja u WEB-31.
- **P-9 Stanje „ceka”.** Predaja potpisuje sinkrono; „ceka” postoji samo nakon 503 `signing`. Pokušava li web sam ponovno (ista revizija) ili samo nudi „Provjeri stanje predaje”? Zadaci zasad grade samo ručnu provjeru. **Blokira:** automatski ponovni pokušaj u WEB-26.
- **P-10 Ishodi predaje koje inventar ne preslikava.** `stale_revision`, `not_acknowledged`, `not_open`, 404, 413 i 426 nemaju varijantu u S: PO-17. Prijedlog: `greska` s vlastitim tekstom po ishodu (`stale_revision` → „Osvježi i pokušaj ponovno”, `not_acknowledged` → povratak na obavijest kolegija). **Blokira:** konačne tekstove tih ishoda u WEB-22 i WEB-26 (mapa se gradi s prijedlogom).

## Zbroj, trake i redoslijed

| Val        | SRV              | WEB/UI           | Ukupno |
| ---------- | ---------------- | ---------------- | ------ |
| 3          | 9 (SRV-17 do 25) | 8 (WEB-21 do 28) | 17     |
| 5          | 7 (SRV-26 do 32) | 8 (WEB-29 do 36) | 15     |
| **Ukupno** | **16**           | **16**           | **32** |

| Traka | Val 3                  | Val 5          | Ukupno |
| ----- | ---------------------- | -------------- | ------ |
| S-A   | SRV-17, 19, 25         | SRV-26, 27, 32 | 6      |
| S-B   | SRV-20, 21             | SRV-28         | 3      |
| S-C   | SRV-18, 22, 23, 24     | SRV-29, 30, 31 | 7      |
| W-A   | WEB-21, 22             | WEB-29, 30     | 4      |
| W-B   | WEB-24, 25, 26, 27, 28 | –              | 5      |
| W-C   | WEB-23                 | WEB-31 do 36   | 7      |

**Kritično (11):** SRV-18, 20, 21, 22, 23, 28, 30 (sve S-B migracije su među njima); WEB-22, 26, 27, 35.

**Redoslijed po trakama:**

- S-A: SRV-19 → SRV-25 → (SRV-17 čim sleti SRV-18) → SRV-27 → SRV-32 → SRV-26.
- S-B: SRV-20 → SRV-21 → SRV-28 (nakon SRV-07 iz vala 4).
- S-C: SRV-18 (čim spoje #348, #352, #353) → SRV-22 → SRV-23 → SRV-24 → SRV-30 → SRV-29 → SRV-31.
- W-A: WEB-21 → WEB-22 → WEB-29 → WEB-30.
- W-B: WEB-24 → WEB-25 → WEB-26 → WEB-27 → WEB-28.
- W-C: WEB-23 → (val 5) WEB-31, WEB-33, WEB-32 → WEB-34 → WEB-35 → WEB-36.

**Procjena paralelnih pisaca:** prvi krug bez čekanja: S-A (SRV-19), S-B (SRV-20) i W-A (WEB-21), dakle 3; S-C kreće sa SRV-18 kad se spoje #353 i ovisni PR-ovi. Vrhunac vala 3 je 6 pisaca (3 SRV + 3 WEB: W-A klijent, W-B tok predaje, W-C radni prostor). U valu 5 serverski dio drži 3 pisca, WEB 2 (W-A pa W-C; W-B je slobodan za val 6). Realno 5 do 6 istodobno.

**Uska grla:** S-C ima 7 zadataka u nizu i čeka otvorene PR-ove #348, #352, #353; W-B (5 zadataka) čeka WEB-22, a WEB-22 čeka izdanje 3.1.0 (SRV-25). Kad bi #353 kasnio, WEB-24 i WEB-25 mogu početi nad lažnim serverom iz vektora 3.1.0.
<!-- VAL-3-5-END -->

### Zajednički alati i CI

Tehničke stavke i kriteriji iz [izvorne revizije](https://github.com/ductura/.github/blob/265ea93a2e14a22902e17d259e31304278c30982/docs/PLAN.md).

| Korak / ID                      | Što                                                                                                                                                                                                                                                                     | Ovisi o                                                                             | Risk                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| U2 (server plan; PRIJEDLOG ID)  | Stvaranje repoa i prvi sadržaj; ide **odmah nakon kostura servera**                                                                                                                                                                                                     | V-1                                                                                 | standard                                                                                                 |
| T-0.1                           | Profil, predlošci issuea i PR-a, labele                                                                                                                                                                                                                                 | U2                                                                                  | standard                                                                                                 |
| T-0.2                           | Reusable workflowi: CI osnova s `ci-ok`, tajne, ovisnosti, gate                                                                                                                                                                                                         | U2, S-0.9; S-0.10-a/b se pišu **ovdje**, ne u serveru, i nema izdvajanja iz servera | critical                                                                                                 |
| — (novo, PRIJEDLOG ID)          | Preseti `@ductura/tsconfig`, `eslint-config`, `prettier-config` na GitHub Packages                                                                                                                                                                                      | U2                                                                                  | standard                                                                                                 |
| T-0.3                           | **Ukinuto 17. 11.** (spajanje po pravilu iz `docs/plan/PLAN-MIGRACIJE.md` §7)                                                                                                                                                                                           | —                                                                                   | —                                                                                                        |
| T-0.4                           | Generator novog repoa                                                                                                                                                                                                                                                   | S-0.6, T-0.2                                                                        | standard                                                                                                 |
| T-0.7                           | Tjedna provjera razilaženja postavki (samo čitanje)                                                                                                                                                                                                                     | T-0.2                                                                               | standard                                                                                                 |
| U11 (server plan; PRIJEDLOG ID) | **Gate prema riziku uz ugovorne testove**: npr. PR koji mijenja `server/contracts/**` je najmanje `critical` i traži zelene ugovorne testove preloadera i weba nad novom verzijom; PR koji ne dira ugovor, a prolazi ugovorne testove, zadržava risk iz tablice putanja | zadnje: nakon ugovora (U4 … U10) i S-1H.8                                           | critical; **zaseban PR pravila, vlasnik potvrđuje** (pravilo gatea mijenja `docs/ENGINEERING_SYSTEM.md`) |

Promjena ponašanja gatea (risk floor, broj aplikacija za `critical`, popis obveznih statusa) nikad ne ide u PR koji radi nešto drugo.

#### 6. Testovi (personalizirano: workflowi i pravila gatea)

| Sloj                            | Konkretni slučajevi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pomoćne funkcije**            | risk-floor: putanja → razina za svaku tablicu repoa; najviša razina pobjeđuje; nepoznata putanja dobiva zadanu razinu; provjera verdikata: redak na krivom headu, krivi format `runtime:slot:role`, isti autor i reviewer, nedostaje QA za `critical`, Owner Override bez SHA. Preneseni testovi Ductusa s istim tvrdnjama.                                                                                                                                                                                         |
| **Statička provjera workflowa** | actionlint na svakom workflowu; svaka akcija prikvačena na SHA (test pada na `@v4`); najmanje dozvole (`permissions`) po poslu; nema `pull_request_target` s checkoutom tuđeg koda; PRIJEDLOG zizmor (besplatan) za sigurnost workflowa.                                                                                                                                                                                                                                                                            |
| **Samotest (integracija)**      | `self-test.yml` poziva svaki reusable workflow nad fixtureom: zeleni Node projekt daje zeleni `ci-ok`; projekt s namjerno palim testom daje crveni `ci-ok`; posao koji se preskoči ne daje lažno zeleni `ci-ok`; tajna u fixtureu ruši `secret-scan`; lockfile s poznatom ranjivošću ruši `osv-scan` (DAN-921); snimljeni `body_html` PR-a s kodom bez tablice koju GitHub prikazuje ruši `tests-table`, isto kao netaknuti predložak PR-a, a predložak s popunjenim retkom-predloškom i docs PR prolaze (DAN-948). |
| **Preseti**                     | fixture koji mora pasti (implicitni `any`, dubok uvoz kad su granice uključene, krivi format) i koji mora proći.                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Generator**                   | novi repo dobiva README, adaptere pravila, CODEOWNERS, PR predložak, risk tablicu i labele; drugi prolaz ne mijenja ništa.                                                                                                                                                                                                                                                                                                                                                                                          |
| **Provjera razilaženja**        | lažni API odgovori: repo bez zaštite grane, bez obveznog `ci-ok`, s viškom labele → nalaz u koordinacijskom issueu; ništa se ne mijenja (samo čitanje).                                                                                                                                                                                                                                                                                                                                                             |
| **Verzije**                     | promjena reusable workflowa ne utječe na repo koji poziva stariji puni SHA (test nad fixtureom s prikvačenim SHA-om); poziv oznakom ili granom pada.                                                                                                                                                                                                                                                                                                                                                                |

Vizualni, pristupačnost i performanse se ne primjenjuju. **Matrica:** `ubuntu-latest`; `windows-latest` i `macos-latest` samo za `ci-dotnet` i `ci-swift` u fazi E. **Prag „gotovo”:** samotest zelen za svaki workflow; svaka akcija prikvačena; preneseni testovi gatea prolaze.

#### 7. CI i gate

- Poslovi: `actionlint`, `pin-check`, `permissions-check` (DAN-970), `unit` (skripte gatea), `self-test`, `node-fail`, `node-skipped` i `red-aggregate` (crveni `ci-ok`, DAN-971), `presets`, `lint-presets`, `secret-scan`, `osv-scan` i `osv-scan-negative` (DAN-921), `tests-table` (DAN-948), `ci-ok-reusable` i obvezni `ci-ok` (običan posao nad svim ostalima, DAN-885), svi u `self-test.yml`. Tjedno `drift-check`.
- Risk: cijeli repo `critical` osim `profile/**` i `ISSUE_TEMPLATE/**` (`low`), jer upravlja gateom svih repoa.
- Vlasničke radnje: stvaranje repoa (V-1 opseg), V-2 i V-3 za ovaj repo; potvrda U11.

#### 8. Kriterij izlaza (prvi val)

1. Server, preloader i web pozivaju reusable workflowe punim SHA-om (oznaka samo kao komentar); nijedan nema vlastitu kopiju gatea.
2. Preneseni testovi gatea prolaze; samotest zelen.
3. Preseti objavljeni i korišteni u sva tri repoa faze A–C.
4. Tjedna provjera razilaženja radi i javlja nalaz.
5. U11 spojen tek nakon vlasnikove potvrde.

### Institucijski server

Tehničke stavke i kriteriji iz [izvorne revizije](https://github.com/ductura/Institution_server/blob/fd0002ef2b782cb28eaf89fff052c6c312f962c0/docs/PLAN.md).

Postojeći ID-evi su iz zadataka §4–§5 i migracije §10b. Koraci U1–U11 su nazivi u ovom planu (**PRIJEDLOG; ID dodjeljuje orkestrator**).

**Odmah nakon kostura (odluke A3, B1, B2, B4):**

| Korak | Što                                                                                                                                                                                                                                                                                                             | Ovisi o           | Promjena                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| U1    | S-0.4 kostur                                                                                                                                                                                                                                                                                                    | V-1               | —                                                                                |
| U2    | `ductura/.github`: reusable workflowi, preseti, predlošci ([plan `.github`](https://github.com/ductura/.github/blob/main/docs/plan/PLAN-MIGRACIJE.md#katalog-zadataka))                                                                                                                                         | V-1               | T-0.1, T-0.2, T-0.4 idu **odmah**, ne izdvajanjem kasnije                        |
| U3    | S-0.2 inventar 38 ruta (Ductus)                                                                                                                                                                                                                                                                                 | —                 | ulaz u ugovor                                                                    |
| U4    | **Ugovor kao izvor koda** (S-1H.1-a proširen): sheme svih ruta u `server/contracts/` (TypeBox, prijedlog zadataka t. 15): ulaz, izlaz, greške (kod i ključ), tko smije. Iz njih generator daje validaciju ulaza na serveru, OpenAPI i dokumentaciju, TS tipove i klijent, lažni server. Generirano = commitano. | U1, U3            | S-1H.1-a pomaknut iz vala 1 (bio ← S-1B-b); router ga koristi kad S-1B-b postoji |
| U5    | S-1H.1-b OpenAPI `v1`, verzija, zaštita od lomljenja                                                                                                                                                                                                                                                            | U4                | iz vala 1                                                                        |
| U6    | S-1H.1-c jedna provjera ID-a rada                                                                                                                                                                                                                                                                               | U4                | iz vala 1                                                                        |
| U7    | S-1H.4 vektori: svaka ruta uspjeh i greška                                                                                                                                                                                                                                                                      | U5                | **iz vala 9**; ne čeka S-M-5                                                     |
| U8    | Lažni server iz ugovora (vraća vektore, ostalo 501)                                                                                                                                                                                                                                                             | U7                | nov; nije S-1H.7                                                                 |
| U9    | **`@ductura/test-fakes`**: lažni AAI OIDC (iz S-0.16), softverski FIDO2, PGlite tvornica po bazi (ako S-0.3 potvrdi), lažna baza zapisa (PGlite s migracijama zapisa, samo dopisivanje), lažne usluge `ok`/`slow`/`down`, lažni sat, lažni server iz U8                                                         | U8, S-0.16, S-0.3 | nov paket; S-1F-e ga kasnije puni                                                |
| U10   | T-0.5 objava `@ductura/contracts` i `@ductura/test-fakes` na **GitHub Packages** iz Actionsa ovog repoa                                                                                                                                                                                                         | U5, U9            | iz vala 9; odluka 2 riješena odlukom B1                                          |

Pravilo nakon U10: **zadatak koji prenosi ili gradi rutu gotov je kad server prolazi vektore te rute.** Nova ruta (postavke, pravni tekstovi, preuzimanje, kontekst klijenta, pregledi zapisa) prvo dobiva shemu i vektore, zatim kod.
**Kasniji klijenti:** C# i Swift klijent iz istog OpenAPI-ja kad krene faza E (PRIJEDLOG generator, bez troška; **otvoreno** do odluke o desktopu).

| Val        | Zadaci                                                                                                                                                                                                | Ključne ovisnosti                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 0 (Ductus) | S-0.1, S-0.2, S-0.3, S-0.21                                                                                                                                                                           | vidi [KARTA](https://github.com/ductura/.github/blob/main/docs/plan/PLAN-MIGRACIJE.md#katalog-zadataka)                               |
| 0          | U1 → U2, U4 … U10 ‖ S-0.5 ‖ S-0.7 ‖ S-0.16 → S-0.6, S-0.8, S-0.12 → S-0.9 (poziva workflowe iz U2) → S-0.10-a → S-0.10-b → S-0.11; S-0.9 → S-0.13 → S-0.14 → S-0.15, S-0.17 → S-0.18, S-0.19 → S-0.20 | S-0.13 ← samo S-0.9 (ne čeka S-0.10-b ni S-0.11); V-1 prije U1; V-4 prije S-0.9; V-2 prije S-0.10-b, S-0.20; V-3 prije S-0.11, S-0.20 |
| 1          | S-1A-a → S-1A-b (granice, §3), S-1L.1 → S-1B-a → S-1B-b ‖ S-1B-c; validacija iz ugovora u routeru                                                                                                     | S-1A-a ← S-0.12; S-1B-a ← S-1A-b, S-0.17                                                                                              |
| 2          | S-1F-a ‖ S-1F-c → S-1F-b, S-1F-d, S-1F-e                                                                                                                                                              | S-1F-e ← S-0.3, U9                                                                                                                    |
| 3          | S-1J.1-a → S-1J.1-b → S-1J-c → S-1J-d; S-1J-e → S-1J-f → S-1J-g; S-1L.2, S-1L.3                                                                                                                       | S-1J.1-b ← V-7 kasnije                                                                                                                |
| 4          | S-1K.1 → S-1K.2-a → S-1K.2-b; S-1K.3-a → S-1K.3-b                                                                                                                                                     | S-1K.2-a ← S-1F-d                                                                                                                     |
| 5          | S-1C.1–S-1C.6; S-1D-a–S-1D-d; S-1E-a–S-1E-g; S-1J.2; S-1J.4; S-1K.4-a/b; S-1K.5-a/b; S-1K.6; S-1M-a–S-1M-c; S-1N-a–S-1N-d; S-3B-a–S-3B-e                                                              | WIP 3; S-1E-b, S-1E-e ← V-5                                                                                                           |
| 6          | S-M-5 (VS-1; uski rez ide ranije, vidi niže), S-M-1, S-M-2a, S-M-2b, S-M-3, S-M-4, S-M-6, S-M-7, S-M-8; S-M-10 zadnji                                                                                 | ← S-1B-b, S-1F-a, U4, S-1L.3, S-1J.1-a, S-1D-d                                                                                        |
| 7          | S-1K.7-a → S-1K.7-b → S-1K.7-c → S-1L.4; S-1K.8; S-1K.9                                                                                                                                               |                                                                                                                                       |
| 8          | S-1G-a → S-1G-b ‖ S-1G-c → S-1G-d → S-1G-e; S-1G-f                                                                                                                                                    | V-6 nakon S-1G-e                                                                                                                      |
| 9          | S-1H.2 (test „tko smije” nad pravim serverom), S-1H.3, S-1H.5 → S-1H.6, S-1H.7 → S-1H.8, S-1L.5                                                                                                       | S-1H.8 ← S-1H.7, U7                                                                                                                   |
| 10         | S-1I                                                                                                                                                                                                  | ← S-1H.8                                                                                                                              |
| zadnje     | U11: **gate prema riziku uz ugovorne testove** (odluka B6), vidi [plan `.github`](https://github.com/ductura/.github/blob/main/docs/plan/PLAN-MIGRACIJE.md#katalog-zadataka)                          | ← U10, S-1H.8; **zaseban PR pravila, vlasnik potvrđuje**                                                                              |

**Nesklad:** S-3B-a ovisi o S-M-3, S-3B-b o S-M-6, S-3B-c o S-M-2a (val 5 naspram 6). Prijedlog: S-3B-a … c nakon pripadnog S-M.
**Zajednički:** VS-1 (S-1E-a, S-1D-d, S-1M-a, S-M-5); VS-2 bez koda servera.

**Uski rez za VS-1 (odluka vlasnika, Ductus#87 c.6880835493 t. 3, potvrda c.6880861260; mijenja D-306 t. 15).** Odmah iza S-0.19, usporedno s valovima 1–5, grade se redom četiri zasebna critical PR-a: **sesija, `open`, `commit`, `replay`**. Svaki se otvara tek kad prethodni uđe u `main` (bez ugniježđenih PR-ova). Rade nad pravim PostgreSQL-om s RLS-om i prenesenim pgTAP testovima, u mapama područja iz §3. Rez **nije izdanje**: valovi 1–5 ostaju uvjet za pilot.

- **Prvi korak** (sesija) potpisuje se u istom odgovoru (protokol 1; O-2), isključivo nad sintetičkim podacima u lokalnom i CI stogu.
- **VS-1b** (`202 pending_signature`, worker, red poslova, oporavak) slijedi odmah, bezuvjetan je i uvjet za osnovicu 20. 12. i za svaki rad sa stvarnim podacima (D-71).
- VS-1 dobiva tvrdnju VS-1.13 (gašenje i ponovno podizanje procesa, zatim ponovljena VS-1.9) i zabranu administratorske veze na bazu kao dokaza čitanja; tekst prihvata je u `PLAN-MIGRACIJE.md` §4a-1.

#### 6. Testovi

**Dvojnici (iz `@ductura/test-fakes`, bez Dockera):** PGlite po bazi za unit i brze integracijske testove (ako S-0.3 potvrdi); lažni OIDC (uspjeh, odbijanje, istek, nedostupno Srce); softverski FIDO2; lažna baza zapisa; lažne usluge `ok`/`slow`/`down`; lažni sat. **Pravi PostgreSQL** za ovlasti, RLS, SECURITY DEFINER, pgTAP, utrke i pg-boss, pokrenut **nativno** (bez Dockera, kao Ductus `scripts/db/native-db.mjs`). pg-mem odbijen. Svi podaci izmišljeni.

| Sloj                         | Konkretni slučajevi za server                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pomoćne funkcije**         | ID rada: ispravan, prazan, predug, `'`, `;`, `%00`, `../`, Unicode (S-1H.1-c); `client-ip` IPv4/IPv6 i lažni `X-Forwarded-For` (S-1C.1); `redact` canary (S-0.17, S-1K.3-a); katalog događaja (S-1K.1); katalog postavki (S-1J-f); `problem` bez stack tracea i SQL-a (S-1L.3); paritet `hr`/`en` i zabranjeni izrazi (S-1L.1); CSV neutralizacija (S-1K.6); pravila analize (S-1K.7-a).                                                       |
| **Property**                 | ID rada; `return-to`; gašenje; IP rasponi i token bucket s lažnim satom (S-1C.3).                                                                                                                                                                                                                                                                                                                                                              |
| **Lint i granice**           | fixture koji mora pasti za svako pravilo (S-0.7); pet pravila granica iz §3 (S-1A-b); svako područje ima `README.md` i `index.ts`; nema tvrdog hrvatskog teksta (S-1L.2).                                                                                                                                                                                                                                                                      |
| **Ugovor (prvi)**            | generirano iz shema = commitano (validacija, OpenAPI, tipovi, klijent, lažni server); detektor lomljenja (S-1H.1-b); ruta mimo inventara ruši test (S-1H.1-a); svaka ruta ima „tko smije” i sve greške; vektori uspjeha i greške, stari prolaze (S-1H.4); lažni server vraća točno vektore (U8); server prolazi vektore svake prenesene rute.                                                                                                  |
| **Dokaz jednakosti**         | preneseni testovi prolaze na izvornom SHA i ovdje; isti broj po PR-u; mijenja se samo poziv, ne tvrdnja.                                                                                                                                                                                                                                                                                                                                       |
| **Integracija (pravi HTTP)** | slojevi i odbijen zahtjev ne stiže do rukovatelja (S-1B-b); tuđi `Origin` → 403; SIGTERM usred zahtjeva (S-1B-c); kolačić `__Host-`, istek, ukraden kolačić nakon odjave → 401 `session_expired` (S-1D-d); četiri načina lažnog OIDC-a (S-1E-a); FIDO2 kriv i kloniran ključ (S-1E-g); operaterska ruta bez drugog faktora → 403 (S-1J.2); pad baze zapisa ne mijenja glavne odgovore (S-1F-a, S-1K.3-b); 429 i ponovljeno spremanje (S-1C.3). |
| **pgTAP**                    | preneseni s istim ishodom (S-0.15); RLS na svakoj tablici (S-1F-b); prava između baza (S-1F-d); vrste računa × radnja (S-1J-d); samo dopisivanje i lanac (S-1K.2-a/b); pravni tekstovi bez UPDATE/DELETE (S-1N-a); brisanje po roku (S-1K.8).                                                                                                                                                                                                  |
| **Matrice ovlasti**          | ruta × sedam uloga, tuđe = nepostojeće (S-1H.2, iz stupca „tko smije”); vrsta × pregled, izvoz i alarm (S-1K.9); revizijski zapis vrsta 3–5 (S-1J.4).                                                                                                                                                                                                                                                                                          |
| **Funkcionalni**             | „vlastiti da, tuđi ne” nad `dist/server.js`, sa SHA (S-1H.3); paritet na razini API-ja S-1H.8/1..6; simulacija preuzimanja za četiri kombinacije sustava i arhitekture (S-1H.6).                                                                                                                                                                                                                                                               |
| **Backup**                   | šifrirana kopija → vraćanje daje iste retke i sažetke; krivi ključ odbijen (S-1G-b … d); tjedna vježba (S-1G-e).                                                                                                                                                                                                                                                                                                                               |
| **Sigurnost**                | gitleaks, dependency review; produkcija s lažnim OIDC-om pada (S-0.16); `DUCTURA_MODE=test` u produkciji pada (S-1H.7); `test-fakes` se ne smije naći u produkcijskoj izgradnji (test ovisnosti); zdravlje bez unutarnjih adresa; `client-context` bez otiska (S-1M-b).                                                                                                                                                                        |
| **Performanse**              | bilježenje ne čeka bazu; zapis prometa ne usporava odgovor. Granice u ms **otvoreno** (mjeriti od S-1I).                                                                                                                                                                                                                                                                                                                                       |

Vizualni i pristupačnost se ne primjenjuju. **Matrica:** `ubuntu-latest`, Node iz `.nvmrc`, PostgreSQL iste glavne verzije kao produkcija (nativno). **Prag „gotovo”:** `ci-ok` zelen; preneseni testovi jednaki Ductusu; ništa preskočeno; svaka tablica ima RLS i retke u matrici; matrice bez prazne ćelije.

#### 7. CI i gate

- **Poslovi** (pozivaju reusable workflowe iz `ductura/.github`): `lint` (s granicama), `format`, `typecheck`, `test-helpers`, `test-functional`, `pgtap-main`, `pgtap-logs`, `pgtap-legal`, `contracts` (generirano = commitano, vektori, lomljenje), `secret-scan`, `dependency-review`, `publish` (na oznaku), `ci-ok`.
- **Obvezno na `main`:** `ci-ok` i statusi gatea. Akcije prikvačene na SHA.
- **Izdanja:** `@ductura/contracts` i `@ductura/test-fakes` na GitHub Packages (U10). Napomena: npm registar GitHub Packages traži token i za javne pakete; u CI-ju istog organizacijskog računa dovoljan je `GITHUB_TOKEN` s `packages: read` uz dodijeljen pristup repou; lokalno treba osobni token s `read:packages`. Zato je svaka verzija i `.tgz` na javnom GitHub Releaseu oznake (`contracts-vX.Y.Z`, `test-fakes-vX.Y.Z`), koji se instalira bez tokena (DAN-966). Kasnije Docker slika testnog servera (S-1H.7) samo kao izdanje.
- **Vlasničke radnje:** V-0 … V-7; potvrda U11.

#### 8. Kriterij izlaza (prvi val)

1. Jedan pravi PR prošao je cijeli gate; ledger migracija jednak Ductusovu.
2. Ugovor `v1` (U4–U8) i paketi (U9, U10) objavljeni prije prvog prenesenog područja; preloader i web ih koriste.
3. Granice područja provjerava CI; nijedno kršenje.
4. Svih 117 zadataka spojeno, osim S-3B-e i izvršnih dijelova S-3B-b i S-3B-d (čekaju D-30 i Q-16).
5. Razvojni token uklonjen; jedina prijava studenata je AAI@EduHr preko lažnog OIDC-a u testu (D-09).
6. S-1H.3 i S-1H.8 prolaze nad `dist/server.js`, sa SHA; S-1H.6 zelen.
7. Server je odigrao svoj dio u VS-1 (sistemski e2e zelen sa SHA svih repoa).

### Institucijski Next.js front

Tehničke stavke i kriteriji iz [izvorne revizije](https://github.com/ductura/Institution_front_web_chrome/blob/28effd7811d7f7c7918d7d3bb3ca711fae7a019b/docs/PLAN.md).

**Ugovor prvi (A3):** web ovisi o ugovoru, ne o gotovom serveru. Svaki ekran se gradi nad lažnim serverom iz `@ductura/test-fakes` čim su shema i vektori rute objavljeni (server U4–U10). Pravi server dolazi u VS-1 i sistemskom e2e.

| ID / korak | Što                                                                                | Ovisi o                                           |
| ---------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| 2.c1       | Popis komponenti **i katalog s vizualnim testovima** od prvog dana (B5)            | `@ductura/ui` oznake                              |
| 2.c2       | Testovi komponenti (u katalogu: svako stanje, svaka širina)                        | 2.c1                                              |
| 2.c3       | Generirani klijent iz `@ductura/contracts`                                         | server U10                                        |
| 2.c4       | Komponente i ekrani po području                                                    | 2.c3 i shema rute (ne gotov server)               |
| 2.c5       | `src/platform`: prilagodbe mogućnosti, mobilni prikaz, tipkovnica, dodir, zamjene  | 2.c4                                              |
| 2.c6       | e2e matrica (§6)                                                                   | 2.c4                                              |
| 2.c7, 2.c8 | **spojeni u 2.c5 i 2.c6** (prije: mobilno i ostali preglednici u zasebnim repoima) | —                                                 |
| E-0.3      | `@ductura/editor-core` u `packages/editor-core`                                    | VS-1, zamrzavanje Ductusa, 4 uvjeta migracije §2d |
| VS-1       | Vertikalni presjek preko pravog API-ja                                             | S-1E-a, S-1D-d, S-1M-a, S-M-5, E-0.2, P-0.1       |
| VS-2       | Drugi presjek (mobilni prikaz u ovom repou)                                        | VS-1; odluka 13 riješena odlukom A1               |

Koraci 2.c1 … 2.c9 nemaju ID (**PRIJEDLOG; ID dodjeljuje orkestrator u fazi 0.3**). 2.c9 (preuzimanje) je u preloaderu (P-0.9).
Područja za 2.c4 slijede serverske valove, ali čekaju samo shemu: račun i postavke (S-1J-_, S-1L.2, S-1L.3), dokumenti i rad (S-1D-_, S-M-_), predaja (S-1C._), nastavnik i admin (S-1K._), stanje (S-1M-_), pravno u aplikaciji (S-1N-_), uvoz (S-1G-_).

#### 6. Testovi (editor, dnevnik, sinkronizacija, ekrani, svi preglednici)

**Dvojnici (iz `@ductura/test-fakes`, bez Dockera):** lažni server iz ugovora, lažni AAI@EduHr, lažni sat, lažne usluge `ok`/`slow`/`down`; `fake-indexeddb` za dnevnik; prekid veze kroz Playwright `offline`; odbijeno dopuštenje kroz `permissions`. Sistemski e2e nad pravim serverom (nativno, `preloader/e2e/system/`). Sintetički tekstovi.

| Sloj                        | Konkretni slučajevi                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pomoćne funkcije**        | shema dokumenta, diff, citati FPZG, brojanje; greške API-ja → poruke iz lokala; paritet `hr`/`en`; provjera mogućnosti vraća pravu zamjenu; izračun vidljivog prostora iz `visualViewport`; raspored po širini.                                                                                                                                                             |
| **Property (editor-core)**  | izmjene i ponovna izgradnja daju isti dokument; dnevnik nakon prekida u bilo kojem trenutku daje zadnje potvrđeno stanje; nema SYNCED bez potpisane potvrde (F-3, F-8); replay provjerava hash obrisanog raspona (B-12); za bilo koju visinu tipkovnice kursor ostaje vidljiv.                                                                                              |
| **Integracija**             | odjava briše dnevnik i zatvara stare kartice; ponovno spajanje prazni red; recovery, rebase, salvage; predaja samo kroz API; IndexedDB u privatnom načinu Firefoxa i Safarija daje upozorenje, ne tihi gubitak; međuspremnik bez dopuštenja.                                                                                                                                |
| **Ugovor**                  | generirani klijent pokreće sve vektore; nepoznato polje odbijeno; prikvačena verzija paketa; CI pada kad nova verzija ugovora lomi klijent.                                                                                                                                                                                                                                 |
| **Katalog i vizualni (B5)** | svaka komponenta u katalogu u svim stanjima (prazno, učitavanje, greška, puno, onemogućeno); snimke na 1440, 1024, 768, 390 i 360 px, svjetla ljuska „papir i grafit” (D-188); usporedba s odobrenom snimkom pada na razlici iznad praga (vrijednost **otvoreno**); nova komponenta bez kataloga ruši test.                                                                 |
| **e2e**                     | S-1H.8/1..6 (prijava, otvaranje rada, pisanje, rad bez veze, ponovno spajanje, predaja); nastavnik: kolegij, zadatak, pregled, komentar; admin fakulteta; tri postojeća scenarija iz kostura; prvi val §4: Chrome (spremi, osvježi, zamjena kad mogućnost fali), mobitel (tipkovnica, okretanje iPada), ostali (učitavanje, navigacija, međuspremnik, odbijeno dopuštenje). |
| **Paritet**                 | `@ductura/parity` S-1H.8/1..6 u svakom stupcu matrice.                                                                                                                                                                                                                                                                                                                      |
| **Pristupačnost**           | WCAG 2.2 AA (Q-14): axe na svakoj stranici i u katalogu; tipkovnica u editoru; fokus nakon dijaloga; dodirne mete; uvećanje 200 %.                                                                                                                                                                                                                                          |
| **Performanse**             | tipkanje u dugom dokumentu (i uz usporeni CPU za mobilno); veliki diff po odlomcima; veličina paketa po stranici.                                                                                                                                                                                                                                                           |
| **Sigurnost**               | nema tajni u izgradnji; CSP bez `unsafe-inline` (proxy); zabranjeni izrazi (PRODUCT §5); XSS kroz zalijepljeni sadržaj; `test-fakes` nije u produkcijskoj izgradnji.                                                                                                                                                                                                        |

**Matrica (A1):** Chromium i pravi Chrome (`channel: 'chrome'`), Firefox, WebKit (Safari), Edge (`msedge`), mobilni viewport u emulaciji (Pixel 7, iPhone 14, iPad, iPad položeno). **Opera: ručna provjera** prije izdanja, zapis u PR-u. Safari na macOS-u noćno po uzoru na `webkit-macos.yml` (PRIJEDLOG). Pravi mobilni uređaji: odluka 9, **otvoreno** (trošak farme je vlasnička odluka).
**Prag „gotovo”:** S-1H.8/1..6 zeleni u svakom stupcu; katalog pokriva svaku komponentu; property testovi editor-corea zeleni; axe bez kršenja; ručni zapis za Operu.

#### 7. CI i gate

- Poslovi (reusable iz `ductura/.github`): `lint`, `typecheck`, `unit`, `property`, `contracts`, `catalog-visual`, `e2e-chrome`, `e2e-firefox`, `e2e-webkit`, `e2e-edge`, `e2e-mobile`, `a11y`, `forbidden-terms`, `secret-scan`, `dependency-review`, `ci-ok`. Noćno `e2e-safari-macos`. Objava `@ductura/ui`, `@ductura/editor-core`, `@ductura/parity` na GitHub Packages (B1).
- Risk `critical`: `packages/editor-core/**`, odjava i lokalna pohrana, predaja, zamjene za pohranu, `.github/**` (PRIJEDLOG tablice, T-0.2).
- Vlasničke radnje: preimenovanje `web-chrome` → `web` i arhiviranje `web-mobile`, `web-other` nakon potvrde plana; V-2, V-3; odluka 1 (putanja); odluka 9.

#### 8. Kriterij izlaza (prvi val)

1. VS-1 zelen kroz pravi proxy; E-0.3 gotov i Ductus zamrznut za editor.
2. S-1H.8/1..6 zeleni u Chromeu, Firefoxu, WebKitu, Edgeu i mobilnoj emulaciji; Opera ručno.
3. Ekrani za svaku objavljenu shemu postoje, prolaze katalog, axe i vizualnu usporedbu.
4. Preneseni testovi iz Ductusa prolaze s istim brojem i tvrdnjama.
5. `@ductura/ui`, `@ductura/editor-core` i `@ductura/parity` objavljeni.

### Preloader i edge

Tehničke stavke i kriteriji iz [izvorne revizije](https://github.com/ductura/Preloader/blob/62ab8aa9ad71e40557d34d025f4abca9e95093ad/docs/PLAN.md).

**Ugovor prvi (A3):** zadaci preloadera ovise o shemi i vektorima rute u ugovoru (server U4–U10), ne o gotovom serveru. Rade nad lažnim serverom iz `@ductura/test-fakes`. Gotov serverski zadatak treba samo za sistemski e2e.

| ID     | Što                                                  | Prije A3 ovisio o                           | Sada ovisi o                                                              | Risk     |
| ------ | ---------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| P-0.1  | Kostur (statična izgradnja, proračun veličine)       | V-1b, T-0.4                                 | V-1b, `ductura/.github` (U2)                                              | standard |
| P-0.2  | Dvije odluke kao čiste funkcije                      | P-0.1                                       | P-0.1                                                                     | standard |
| P-0.3  | Ručni izbor prikaza i paketa, pamćenje               | P-0.2                                       | P-0.2                                                                     | standard |
| P-0.11 | Matrica u Playwrightu, tri motora                    | P-0.3                                       | P-0.3                                                                     | standard |
| P-0.4  | Provjera servera i verzije API-ja                    | S-1M-a                                      | shema `health` (U4, U7)                                                   | standard |
| P-0.5  | Stranice grešaka iz kataloga                         | S-1M-c                                      | katalog grešaka u ugovoru (U4)                                            | standard |
| P-0.8  | Slanje konteksta klijenta                            | S-1M-b                                      | shema `client-context`                                                    | standard |
| P-0.7  | Ulaz u prijavu AAI@EduHr; FIDO2 za mrežnog inženjera | S-1E-a, S-1E-g                              | sheme `auth/*` + lažni OIDC i FIDO2 (U9); spajanje tek uz S-1E-a i S-1E-g | critical |
| P-0.6  | Traka kolačića i ekran pristanka                     | S-1N-d                                      | shema pristanka i `legal`; spajanje uz S-1N-d                             | critical |
| P-0.9  | Info stranica, pravni tekstovi, preuzimanje          | S-1N-c, S-1H.5                              | sheme `legal`, `downloads`                                                | standard |
| P-0.10 | Proxy na domeni i lokalni sistemski stog             | S-1H.7                                      | S-1H.7 (treba pravi server)                                               | critical |
| VS-1   | Vertikalni presjek (ulaz i preusmjeravanje)          | S-1E-a, S-1D-d, S-1M-a, S-M-5, E-0.2, P-0.1 | isto                                                                      | critical |

Za `critical` zadatke (P-0.6, P-0.7) PRIJEDLOG: gradi se nad lažnim serverom, a spaja tek kad pravi serverski zadatak prođe iste vektore. P-0.7 ne gradi prijavu admina aplikacije (pitanje 8).

#### 6. Testovi (prepoznavanje, usmjeravanje, greške, pristanak)

**Dvojnici (bez Dockera):** lažni server iz ugovora (`@ductura/test-fakes`) s vektorima `health` (`ok`, `degraded`, nedostupan, kriva verzija), katalogom grešaka i manifestom (pun, prazan, bez jednog sustava); lažni AAI@EduHr i lažni FIDO2 iz istog paketa; UA i client hints kao fixturei. Sistemski e2e nad pravim serverom pokrenutim nativno.

| Sloj                            | Konkretni slučajevi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pomoćne funkcije (tablično)** | Za svaki redak prvog vala §3, novi ishod nakon A1: Windows+Chrome → web, prikaz računalo, gumb Windows; Mac+Chrome → web, računalo, macOS; Windows+Edge/Firefox/Opera → web, računalo, Windows; Mac+Safari/Firefox → web, računalo, macOS; mobitel ili tablet → web, prikaz mobilno, bez istaknutog paketa; Linux ili nepoznat → web, računalo, ručni izbor paketa. Rubni: Edge i Opera s oznakom Chrome; iPad u desktop načinu (UA kao Mac, dodir); uski prozor; client hints prisutni i odsutni; UA i hints se ne slažu (hints pobjeđuju). Ulaz nikad nema više od dopuštenih polja. |
| **Property**                    | nasumičan UA i hints daju jedan prikaz i najviše jedan istaknut paket; ručni izbor uvijek pobjeđuje; ništa ne pokreće preuzimanje.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Integracija**                 | `ok` nastavlja, `degraded` upozorava, nedostupan → greška ili offline, `minClientVersion` veći od izgradnje → osvježavanje (P-0.4); svaki status (400, 401, 403, 404, 408, 429, 500, 502, 503, 504, offline, `session_expired`) ima stranicu i tekst iz lokala (P-0.5); `client-context` šalje samo zatvorene vrijednosti, jednom (P-0.8).                                                                                                                                                                                                                                             |
| **Ugovor**                      | generirani klijent prolazi vektore `health`, `client-context`, `legal`, `downloads`, `auth/login`; nova verzija ugovora koja lomi preloader ruši CI.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Dokaz jednakosti**            | preneseni testovi (§4) prolaze s istim tvrdnjama.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **e2e (P-0.11)**                | Chromium, Firefox, WebKit uz emulaciju: Desktop Chrome (Windows i Mac UA), Edge, Firefox, Safari, Pixel 7, iPhone, iPad, iPad u desktop načinu, prozor 600 px; za svaki: pravi prikaz, pravi gumb, ručna promjena se pamti; nedostupan paket nudi nastavak u webu. Opera ručno.                                                                                                                                                                                                                                                                                                        |
| **Pristanak i kolačići**        | bez pristanka samo nužni kolačić sesije; izbor se pamti i mijenja; nova verzija uvjeta traži ponovni pristanak (`consentRequired: true`); popis kolačića = stvarni `Set-Cookie` (P-0.6).                                                                                                                                                                                                                                                                                                                                                                                               |
| **Prijava**                     | gumb vodi samo na AAI@EduHr; za studenta nema drugog puta; mrežni inženjer dobiva FIDO2 korak (P-0.7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Proxy**                       | `/` → preloader, putanja weba → izgradnja `ductura/Institution_front_web_chrome`, `/api/v1/` → server, `/preuzimanje/` → server; nepoznata putanja → 404; kolačić `__Host-` na jednom porijeklu; CSP i zaglavlja na svakoj putanji (P-0.10).                                                                                                                                                                                                                                                                                                                                           |
| **Sistemski e2e**               | `e2e/system/`: domena → preloader → web → server kroz pravi proxy (VS-1), noćno i za kandidata izdanja; SHA svakog repoa.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Vizualni**                    | prvi ekran, info, greške, traka kolačića na 1440, 768 i 400 px, „papir i grafit” (D-188), usporedba s odobrenom slikom (SESSIONS §6).                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Pristupačnost**               | axe na svakoj stranici; tipkovnica kroz traku kolačića i ručni izbor; kontrast D-188.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Performanse**                 | proračun veličine JS-a prvog ekrana (granica **otvoreno**, PRIJEDLOG odrediti u P-0.1); vrijeme do prvog prikaza.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Sigurnost**                   | zatvoren popis poslanih polja; prepoznavanje nikad za pristup; zabranjeni izrazi; gitleaks i dependency review; `test-fakes` nije u izgradnji.                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Prag „gotovo”:** svi retci matrice i rubni slučajevi zeleni u unit testu i u tri motora; svaka greška ima tekst; proxy pokriva svaku putanju; sistemski e2e zelen sa SHA; vizualna usporedba odobrena.

#### 7. CI i gate

- Poslovi (reusable iz `ductura/.github`): `lint`, `typecheck`, `test-helpers`, `test-functional` (nad lažnim serverom), `contracts`, `e2e-matrix`, `size-budget`, `a11y`, `secret-scan`, `dependency-review`, `ci-ok`. Noćno `e2e-system`.
- Risk `critical`: `deploy/edge/**`, `src/consent/**`, `src/sign-in/**`, `.github/**` (PRIJEDLOG tablice, T-0.2).
- Vlasničke radnje: V-1b, V-2, V-3, odluka 1 (putanja weba i prikaz), V-0 (e-pošta; domena je odlučena 17. 11.: `ductura.org`).

#### 8. Kriterij izlaza (prvi val)

1. P-0.1 … P-0.11 spojeni; putanje usklađene s odlukom 1 i A1; domena je `ductura.org`.
2. Matrica zelena u tri motora; ručni izbor radi svugdje; Opera ručno.
3. Prijava samo AAI@EduHr; pristanak i kolačići po 3d.
4. Sistemski e2e (VS-1) zelen kroz pravi proxy, sa SHA svih repoa.
5. Gumbi za preuzimanje vode na manifest servera; bez paketa korisnik nastavlja u webu.

### Windows ljuska

Tehničke stavke i kriteriji iz [izvorne revizije](https://github.com/ductura/Desktop_windows/blob/f358589e21a9dbe8ee38b5d7b2c818a2934ab006/docs/PLAN.md).

| Korak                               | Što                                                                                                                                                               | Ovisi o                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| D1 (DAN-878)                        | Ovaj plan                                                                                                                                                         | —                                                               |
| D-0.1                               | Spike ljuske (WebView2, WKWebView, Tauri) s istom web izgradnjom, u Ductusu                                                                                       | kraj faze B                                                     |
| odluke 8 i 12                       | Vlasnik                                                                                                                                                           | D-0.1; najkasnije kraj faze C                                   |
| Faza E · aktivacija desktop razvoja | Vlasnička radnja, odvojena od V-1b (karta §3)                                                                                                                     | vlasnik; ulaz faze E (migracija §4): odluke 8 i 12, potpis, V-5 |
| ljuska                              | Prozor učitava isti web paket s provjerene adrese (`WebAddress`)                                                                                                  | odluka 8, aktivacija faze E                                     |
| prijava                             | Token u zaglavlju po ADR-u S-1E-e; samo preko servera                                                                                                             | S-1E-e, V-5 (Srce)                                              |
| klijent ugovora                     | Iz OpenAPI-ja u `@ductura/contracts`; vektori u CI-ju                                                                                                             | U10, odluka 8                                                   |
| izdanje                             | GitHub Release desktop repoa kao izvor paketa. Server u manifestu drži adresu i SHA-256, a korisnik preuzima kroz `/preuzimanje/` (PRIJEDLOG, migracija §8 t. 8). | S-1H.5, S-1H.6, odluka 12                                       |
| potpis                              | Potpisani paket                                                                                                                                                   | ovisi o potpisu                                                 |

Koraci bez ID-a su PRIJEDLOG: ID dodjeljuje orkestrator.

#### 6. Testovi

| Sloj                       | Konkretni slučajevi                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Pomoćne funkcije**       | Argumenti, nazivi paketa, ID rada, adresa weba i ishod `--smoke` (postoje). Nove funkcije ljuske dobivaju testove u `Windows Core`. |
| **Funkcionalni**           | Preuzimanje, instalacija i pokretanje iz izbornika Start. Razmaci i hrvatski znakovi u putanji (karta §4).                          |
| **Ugovor**                 | Klijent prikvači verziju ugovora i pokreće njegove vektore (migracija §6).                                                          |
| **Paritet**                | `@ductura/parity` S-1H.8/1..6 u ljusci (ovisi o odluci 8).                                                                          |
| **Simulacija preuzimanja** | Pravi paket, SHA-256 jednak manifestu, preuzimanje samo na klik (migracija §6). Pokreće ga CI desktopa pri izdanju.                 |
| **Sigurnost**              | Nema tajni (`secret-scan`). Ljuska otvara samo provjerenu adresu. Prijava ide samo preko servera.                                   |

**Matrica:** `windows-latest` (x64) za izgradnju i funkcionalni test, `ubuntu-latest` za `ci-ok-test` i `contract-client`.
**Prag „gotovo”:** `ci-ok` je zelen i ništa nije preskočeno. Funkcionalni test na čistom Windowsu prolazi.

#### 7. CI i gate

- **Danas** (`.github/workflows/ci.yml`, `permissions: contents: read`, svaki `uses:` na punom SHA-u):
  - `build-test` (`windows-latest`);
  - `ci-ok-test`;
  - `secret-scan` i `dependency-review` iz `ductura/.github`;
  - `contract-client`: generirani klijent jednak je zaključanom ugovoru (DAN-958); vektori ID-a rada iz istog izdanja vrte se u `build-test` (DAN-1000);
  - obvezni `ci-ok`.
- **Kasnije:**
  - reusable `ci-dotnet` iz `ductura/.github` (ime vrijedi samo uz put A, ovisi o odluci 8);
  - ostali vektori ugovora (izvan ID-a rada i `health`);
  - izdanje na oznaku `vX.Y.Z` kao potpisani paket u GitHub Releaseu (migracija §5; ovisi o potpisu).
- **Risk (PRIJEDLOG):** `.github/**` je `critical`, kao u drugim repoima. Ostale putanje dodjeljuje tablica rizika.
- **Vlasničke radnje:**
  - Faza E · aktivacija desktop razvoja;
  - certifikat za Windows (ovisi o potpisu);
  - V-0, V-2, V-3 i V-5;
  - odluke 8 i 12.

#### 8. Kriterij izlaza (faza E; ovisi o odlukama 8 i 12 i o potpisu)

Izlaz faze E prema migraciji §4: „Potpisani paketi; instalacija i pokretanje na čistom Windowsu i Macu; gumbi preloadera vode na prava izdanja”. Za ovaj repo to znači:

1. Paket je potpisan (ovisi o potpisu) i objavljen u GitHub Releaseu. SHA-256 je jednak onom u manifestu servera.
2. Instalacija i pokretanje prolaze na čistom Windowsu, uz razmake i hrvatske znakove u putanji.
3. Gumb preloadera za Windows vodi na to izdanje.
4. Editor dolazi iz web paketa. Nema nijednog retka izvornog editora.
5. Prijava ide samo preko servera, tokom (S-1E-e). Za studente je to AAI@EduHr (D-09).
6. `ci-ok` je zelen. Prihvat vala s instalacijom desktopa je **otvoren** (karta §4).

### macOS ljuska

Tehničke stavke i kriteriji iz [izvorne revizije](https://github.com/ductura/Desktop_macos/blob/0126b348dc5c755efad446d03be7a9a171822fbb/docs/PLAN.md).

| Korak                               | Što                                                                                                                                                               | Ovisi o                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| D1 (DAN-878)                        | Ovaj plan                                                                                                                                                         | —                                                               |
| D-0.1                               | Spike ljuske (WebView2, WKWebView, Tauri) s istom web izgradnjom, u Ductusu                                                                                       | kraj faze B                                                     |
| odluke 8 i 12                       | Vlasnik                                                                                                                                                           | D-0.1; najkasnije kraj faze C                                   |
| Faza E · aktivacija desktop razvoja | Vlasnička radnja, odvojena od V-1b (karta §3)                                                                                                                     | vlasnik; ulaz faze E (migracija §4): odluke 8 i 12, potpis, V-5 |
| ljuska                              | Prozor učitava isti web paket s provjerene adrese (`WebAddress`)                                                                                                  | odluka 8, aktivacija faze E                                     |
| prijava                             | Token u zaglavlju po ADR-u S-1E-e; samo preko servera                                                                                                             | S-1E-e, V-5 (Srce)                                              |
| klijent ugovora                     | Iz OpenAPI-ja u `@ductura/contracts`; vektori u CI-ju                                                                                                             | U10, odluka 8                                                   |
| izdanje                             | GitHub Release desktop repoa kao izvor paketa. Server u manifestu drži adresu i SHA-256, a korisnik preuzima kroz `/preuzimanje/` (PRIJEDLOG, migracija §8 t. 8). | S-1H.5, S-1H.6, odluka 12                                       |
| potpis                              | Potpisani paket                                                                                                                                                   | ovisi o potpisu                                                 |

Koraci bez ID-a su PRIJEDLOG: ID dodjeljuje orkestrator.

#### 6. Testovi

| Sloj                       | Konkretni slučajevi                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pomoćne funkcije**       | Argumenti, nazivi paketa, ID rada, adresa weba i ishod `--smoke` (postoje). Nove funkcije ljuske dobivaju testove u `DucturaCore`.                                   |
| **Funkcionalni**           | Preuzimanje, mapa Aplikacije i pokretanje; arhitektura (Apple Silicon i Intel) (karta §4). Nakon potpisa (ovisi o potpisu): prvo pokretanje bez blokade Gatekeepera. |
| **Ugovor**                 | Klijent prikvači verziju ugovora i pokreće njegove vektore (migracija §6).                                                                                           |
| **Paritet**                | `@ductura/parity` S-1H.8/1..6 u ljusci (ovisi o odluci 8).                                                                                                           |
| **Simulacija preuzimanja** | Pravi paket, SHA-256 jednak manifestu, preuzimanje samo na klik (migracija §6). Pokreće ga CI desktopa pri izdanju.                                                  |
| **Sigurnost**              | Nema tajni (`secret-scan`). Ljuska otvara samo provjerenu adresu. Prijava ide samo preko servera.                                                                    |

**Matrica:** `macos-latest` za izgradnju i funkcionalni test, `ubuntu-latest` samo za `ci-ok-test`.
**Prag „gotovo”:** `ci-ok` je zelen i ništa nije preskočeno. Funkcionalni test na čistom Macu prolazi.

#### 7. CI i gate

- **Danas** (`.github/workflows/ci.yml`, `permissions: contents: read`, svaki `uses:` na punom SHA-u):
  - `build-test` (`macos-latest`);
  - `ci-ok-test`;
  - `secret-scan` i `dependency-review` iz `ductura/.github`;
  - obvezni `ci-ok`.
- **Kasnije:**
  - reusable `ci-swift` iz `ductura/.github` (ime vrijedi samo uz put A, ovisi o odluci 8);
  - vektori ugovora za ostale rute (generirani klijent prema zaključanom OpenAPI-ju je u `ci-ok-test`, DAN-959; `health` vektori su u `swift test`, DAN-999);
  - izdanje na oznaku `vX.Y.Z` kao potpisani paket u GitHub Releaseu (migracija §5; ovisi o potpisu).
- **Risk (PRIJEDLOG):** `.github/**` je `critical`, kao u drugim repoima. Ostale putanje dodjeljuje tablica rizika.
- **Vlasničke radnje:**
  - Faza E · aktivacija desktop razvoja;
  - Apple Developer račun (ovisi o potpisu);
  - V-0, V-2, V-3 i V-5;
  - odluke 8 i 12.

#### 8. Kriterij izlaza (faza E; ovisi o odlukama 8 i 12 i o potpisu)

Izlaz faze E prema migraciji §4: „Potpisani paketi; instalacija i pokretanje na čistom Windowsu i Macu; gumbi preloadera vode na prava izdanja”. Za ovaj repo to znači:

1. Paket je potpisan i notariziran (ovisi o potpisu) i objavljen u GitHub Releaseu. SHA-256 je jednak onom u manifestu servera.
2. Instalacija i pokretanje prolaze na čistom Macu, na Apple Siliconu i Intelu.
3. Gumb preloadera za macOS vodi na to izdanje.
4. Editor dolazi iz web paketa. Nema nijednog retka izvornog editora.
5. Prijava ide samo preko servera, tokom (S-1E-e). Za studente je to AAI@EduHr (D-09).
6. `ci-ok` je zelen. Prihvat vala s instalacijom desktopa je **otvoren** (karta §4).

### Povijesni FPZG demo i dokazi

Prilog zahtjeva iz [izvorne revizije](https://github.com/ductura/.github/blob/265ea93a2e14a22902e17d259e31304278c30982/docs/ductus/PLAN-DEMO.md). Datirani rasporedi i povijesni opisi služe sljedivosti.

Verzija 0.1 · 3. 10. 2026. · Odgovorna osoba: Daniel Rišavi · Cilj: **ponedjeljak 2. 11. 2026.** (D-82)

**Povijesni zapis (D-191, 30. 10. 2026.):** demo je odgođen bez datuma i ovaj dokument više nije radni plan. Nositelj plana je `docs/PROGRAM.md`.

Razrada odjeljka "Demo za fakultet" iz `PROGRAM.md` (D-76) na zadatke za sesije iz `docs/SESSIONS.md`. Svaki zadatak orkestrator šalje u obliku predloška iz `SESSIONS.md` §3; ova tablica je izvor za te poruke. Kad se plan i `PROGRAM.md` razlikuju u opsegu, vrijedi `PROGRAM.md`, a razlika se prijavljuje orkestratoru.

#### 1. Što demo mora pokazati

Prema `PROGRAM.md`, na izmišljenom zadatku, lokalno u Dockeru, s lažnom prijavom označenom "demo prijava":

1. Nastavnik stvara kolegij i zadatak s obaviješću studentu (S3).
2. Student piše u pravom editoru (naslovi, citat, bibliografija u osnovnom obliku); stanja spremanja su stvarna, uključujući rad bez mreže i povratak.
3. Nastavnik vidi spremljeno stanje rada i ostavlja komentar uz odlomak.
4. Student predaje; poslužitelj rekonstruira rad, usporedba se podudara, student dobiva potpisanu potvrdu.
5. Student i nastavnik vide isti sažetak procesa; nema zabranjenih riječi ni postotaka.
6. Brz put za nastavnika (D-80): tekst rada, četiri retka i stanje zapisa.
7. Prvi ekran zadatka citira dopuštene i zabranjene uporabe iz FPZG čl. 8 (D-80).
8. Dvije izmišljene povijesti koje Ductus ne može razlikovati, uz objašnjenje granica zapisa (D-80).

**Izlazni kriterij:** prolaz 1 do 5 snimljen, E2E test tog prolaza zelen u CI-ju, nijedan stvarni osobni podatak. Točke 6 do 8 su u demou, ali nisu u izlaznom kriteriju; ako se kasni, režu se prve (§5).

#### 2. Temelji demoa

**Odlučeno:** D-07, D-10, D-11 i D-24 (potvrđeni u D-81), citatni stil kopiran iz Lekte (D-83), sučelje samo na hrvatskom s tekstovima u ključevima (D-84; izravni hrvatski tekst izvan kataloga: odgođeno do engleskog, D-70 dopuna 11. 10. 2026.), izgled editora i nastavničkog sučelja po prototipu (D-85).

**Gradi se iza sučelja, jer je promjena jeftina (status uz svaku stavku):** OIDC klijent `openid-client` (D-73 bira biblioteku na M1), red poslova pg-boss (D-74, potvrđeno 10. 10. 2026.), potpis razvojnim Ed25519 ključem umjesto KMS-a (D-71, potvrđeno 10. 10. 2026.), lokalni Postgres i S3-kompatibilna pohrana umjesto dobavljača (D-08). Ništa od toga ne veže demo uz dobavljača.

**Izvan demoa:** AAI prijava, AI pomoćnik, Lekta paket osim citatnog stila, uvoz i izvoz, dnevni korijen, mentorski radovi, reprodukcija, izravne izmjene nastavnika (D-34), engleski.

#### 3. Tokovi i tjedni

| Tjedan | Razdoblje         | Kontrolna točka (petak)                                                                                                        |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| T1     | 3. do 11. 10.     | Kostur, CI i lokalni stog spojeni; dizajn odobren                                                                              |
| T2     | 12. do 18. 10.    | Jezgra prenesena (isti broj testova kao izvor); prijava i model fakulteta s pgTAP matricom; editor u aplikaciji sprema lokalno |
| T3     | 19. do 25. 10.    | Evidencija na poslužitelju s potpisanim potvrdama; nastavnik vidi stanje i komentira; obavijest S3 i upis kodom                |
| T4     | 26. 10. do 1. 11. | Predaja s rekonstrukcijom, sažetak procesa, E2E prolaz 1 do 5 zelen u CI-ju; proba u subotu 31. 10.                            |

Na svakoj kontrolnoj točki orkestrator uspoređuje stanje s tablicom i, ako se kasni, primjenjuje rezove iz §5 i javlja Danielu. **Stanje 11. 10. 2026. (D-105; issue #87, komentar 6105201573):** zasad se ništa ne reže; rok srijeda 14. 10. za #206 je točka u kojoj orkestrator ponovno iznosi stanje, ne automatski rez. Već primijenjeno iz D-98 time nije promijenjeno.

#### 4. Zadaci

Oznaka uloge: P Platforma, B Backend, F Frontend, K kratkotrajna sesija, D Daniel. "Gotovo kad" je uvijek uz zelene testove, otvoren PR i zeleni Engineering review gate prema risk razini iz `docs/ENGINEERING_SYSTEM.md`, osim gdje piše drukčije. Za svaki backend zadatak uz to vrijede tvrda pravila iz `CLAUDE.md` i kontrolna lista iz `docs/BACKEND.md` §6: svaka nova tablica ima RLS i retke u pgTAP matrici s testom odbijanja; RPC-i izvode identitet iz `current_actor()`, nikad iz parametra; svaka ruta koja mijenja stanje odbija zahtjev bez ispravnog `Origin` i `Sec-Fetch-Site`.

##### Platforma

| ID  | Zadatak                                                                                                                                                                                                        | Ovisi o  | Gotovo kad                                                               | T   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ | --- |
| P-1 | M0.1 kostur: pnpm, Node 24, Next.js i React kao u `pisac-editor`, TypeScript strict, ESLint, Vitest (unit, property), Playwright konfiguracija; bez Supabasea i Netlifyja                                      |          | `pnpm install`, `lint`, `typecheck`, `test` zeleni                       | T1  |
| P-2 | M0.4a CI na GitHub Actions: lint, typecheck, unit, property, Gitleaks, zizmor, Semgrep, OSV; lefthook lokalno                                                                                                  | P-1      | CI zelen na `main`; namjerno pokvaren test ruši CI                       | T1  |
| P-3 | M0.4b `docker compose`: Postgres 17, S3-kompatibilna pohrana (RustFS; MinIO više nema sliku), Mailpit, lažni OIDC pružatelj (`node-oidc-provider`) s jasnom oznakom "demo prijava"; jedna naredba za podizanje | P-1      | `pnpm stack:up` diže sve; zdravstvene provjere zelene; isto radi u CI-ju | T1  |
| P-4 | Migracije s dbmateom (D-91) i pgTAP u CI-ju (`pg_prove` nad Postgresom iz compose); zaštitne mjere iz D-91 u zasebnom PR-u                                                                                     | P-3      | Prazna migracija i jedan pgTAP test prolaze lokalno i u CI-ju            | T2  |
| P-5 | E2E u CI-ju: Playwright nad stogom iz compose, axe, snimke zaslona i video kao artefakti PR-a                                                                                                                  | P-2, P-3 | Primjer E2E testa zelen u CI-ju; snimke vidljive uz PR                   | T2  |
| P-6 | Provjera zabranjenih riječi u CI-ju (rječnik iz `PRODUCT.md` §5) nad tekstovima sučelja                                                                                                                        | P-2      | Riječ iz rječnika u ključu teksta ruši CI                                | T2  |
| P-7 | Demo naredbe: `pnpm local:up` (stog, migracije, izmišljeni podaci) i kratke upute za Daniela                                                                                                                   | P-3, K-3 | Daniel s čistog stanja podiže demo jednom naredbom                       | T4  |

##### Backend

| ID   | Zadatak                                                                                                                                                                                                                                         | Ovisi o                                 | Gotovo kad                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | T            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| B-1  | Plan prijenosa backend jezgre (samo čitanje)                                                                                                                                                                                                    |                                         | Plan poslan orkestratoru                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | T1           |
| B-2  | M0.2a prijenos domene i forenzike (`src/domain` bez dijelova Frontenda)                                                                                                                                                                         | P-1, B-1                                | Isti broj prenesenih testova kao u izvoru, svi zeleni                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | T1 do T2     |
| B-3  | M0.2b prijenos `application/ports`, `application/evidence`, in-memory adaptera i ugovornih testova                                                                                                                                              | B-2                                     | Isti broj testova kao u izvoru                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | T2           |
| B-4  | M0.2c crypto adapteri: razvojni Ed25519 potpisnik u upotrebi, KMS adapter prenesen ali ne spojen                                                                                                                                                | B-3                                     | Ugovorni testovi potpisnika zeleni                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | T2           |
| B-5  | Uloge baze (`ductus_migrator`, `ductus_app`, `ductus_worker`, `ductus_evidence`), sesije u bazi, `current_actor()`, `withActor` (BACKEND §3, §4.3)                                                                                              | P-4                                     | Tablica sesija s uključenim RLS-om i retkom u pgTAP matrici; pgTAP: `ductus_app` ne vidi tablicu sesija ni uz isključen `REVOKE`; test da GUC ne ostaje na vezi                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | T2           |
| B-6  | Prijava preko lažnog OIDC-a: `openid-client`, PKCE, `state`, `nonce`, sesija u bazi, kolačić `__Host-`, odjava; test da produkcijska konfiguracija nema lažnog pružatelja                                                                       | B-5, P-3                                | Prijava i odjava rade; navedeni testovi zeleni                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | T2           |
| B-7  | Model fakulteta za demo (dio M2): fakultet, kolegij, članstvo, upis kodom, zadatak i verzija zadatka, potvrda obavijesti; RLS i pgTAP matrica                                                                                                   | B-5                                     | Matrica pristupa zelena za studenta, nastavnika i stranca (drugi kolegij)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | T2 do T3     |
| B-8  | Evidencija (dio M3): ruta `ingest`, odsječci (D-24), jedan RPC za CAS reviziju i `reserve`, hash lanac, spremanje u lokalnu S3 pohranu, idempotentno ponovno slanje                                                                             | B-3, B-7, #240 (D-103)                  | Property testovi: izmjena, brisanje ili preslagivanje odsječka ruši provjeru; ponovno slanje ne duplicira; RPC izvodi identitet iz `current_actor()` i pgTAP dokazuje da `ductus_app` ne može dodati evidenciju s tuđim principalom; RLS i pgTAP retci za sve nove tablice evidencije; `ingest` odbija zahtjev s pogrešnim ili nedostajućim `Origin` i `Sec-Fetch-Site` (test); svaka nova tablica rada, dokumenta, evidencije i predaje nosi ključ ustanove, složeni strani ključ koji sprječava miješanje ustanova (kao u postojećem modelu ustanove), RLS vezan uz ustanovu i retke u pgTAP matrici s personama druge ustanove (D-103) | T3           |
| B-9  | **Izlazi iz demoa (D-98 dopuna, 10. 10. 2026.; ide nakon demoa).** Worker: pg-boss, potpis potvrda razvojnim ključem, `attach_signature`; stanje `pending_signature`                                                                            | B-4, B-8                                | Potvrda potpisana po D-92 i prolazi ugovorni known-answer vektor iz BACKEND §4.1 (točni ulazni bajtovi, `D`, potpis testnim ključem), uključujući negativne slučajeve (potpis nad punim JCS-om, nad samim `D`, s drugim prefiksom ili nad izmijenjenim payloadom se odbija; v1 `pending_signature` ne potpisuje se v2 putem); pad workera ostavlja `pending_signature` i oporavlja se                                                                                                                                                                                                                                                     | T3           |
| B-10 | Komentari uz odlomak: tablica, RPC, RLS, pgTAP                                                                                                                                                                                                  | B-7                                     | Student vidi komentar na svom radu; stranac ne vidi ništa                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | T3           |
| B-11 | Pogled nastavnika: spremljeno stanje rada s osvježavanjem po P-03 (polling, D-06); podaci za brz put (D-80): zadnja promjena, otvoreni zahtjevi, lijepljenja bez izvora, stanje izjave                                                          | B-8                                     | Nastavnik ne dobiva novo stanje češće od P-03; test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | T3 do T4     |
| B-12 | Predaja (dio M7): `requested_at` iz sata baze, rekonstrukcija (za demo u web procesu, od prvog događaja, bez tablice kontrolnih točaka; D-98 dopuna), JCS usporedba, nepodudarnost blokira predaju (D-11), praznina vidljiva, potpisana potvrda | B-4, B-8 (B-9 nakon demoa; D-98 dopuna) | Rekonstrukcija podudarna na scenarijima uključujući prazninu; nepodudarnost blokira; nove tablice predaje nose ključ ustanove (D-103)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | T4           |
| B-13 | Sažetak procesa: jedna funkcija za studenta i nastavnika (pravilo 5), sesije (P-01), lijepljenja (P-02), praznine, vrsta dokaza (D-44), stanje zapisa                                                                                           | B-8                                     | Test jednakosti studentskog i nastavničkog prikaza, uključujući API (D-80 točka 6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | T4           |
| B-14 | Tanki prolaz kritičnog puta (D-98 t. 1, §7): `ingest` → rekonstrukcija → JCS usporedba, bez sučelja, baze i workera                                                                                                                             | B-3, B-4                                | `ingest` jednog odsječka, rekonstrukcija i JCS usporedba prolaze od početka do kraja nad in-memory adapterima i razvojnim potpisnikom, kao automatski test u CI-ju                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | T2 (18. 10.) |

##### Frontend

| ID   | Zadatak                                                                                                                                                                                                                                             | Ovisi o         | Gotovo kad                                                               | T        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------ | -------- |
| F-1  | Plan prijenosa editora, journala i sinkronizacije (samo čitanje)                                                                                                                                                                                    |                 | Plan poslan orkestratoru                                                 | T1       |
| F-2  | M0.3a prijenos `src/domain/sync`, `document`, `diff`, `serverSync`                                                                                                                                                                                  | P-1, F-1        | Isti broj testova kao u izvoru                                           | T1 do T2 |
| F-3  | M0.3b editor (Tiptap), journal (Dexie) i klijent sinkronizacije s testovima; adapteri prema Supabaseu zamijenjeni sučeljem                                                                                                                          | F-2             | Isti broj testova kao u izvoru                                           | T2       |
| F-4  | Ljuska aplikacije po odobrenom dizajnu: tokeni, raspored, navigacija, tekstovi u ključevima (hr; D-84, uz dopunu D-70 od 11. 10. 2026.)                                                                                                             | P-1, D-2        | Snimke zaslona odgovaraju odobrenom dizajnu; axe bez kritičnih nalaza    | T2       |
| F-5  | Ekran "demo prijava" i odjava; odjava uvijek zatvara sesiju, a nepredani zapis ostaje vezan uz studenta i nastavlja se pri njegovoj ponovnoj prijavi (D-118); druga osoba ne vidi journal prethodnog korisnika                                      | B-6, F-4        | E2E: prijava, odjava s nesinkroniziranim promjenama, prijava druge osobe | T2 do T3 |
| F-6  | Nastavnik: stvaranje kolegija i zadatka s obaviješću S3 i popisom dopuštenih i zabranjenih uporaba iz FPZG čl. 8                                                                                                                                    | B-7, F-4        | E2E: nastavnik stvara zadatak                                            | T3       |
| F-7  | Student: upis kodom, prvi ekran zadatka (obavijest i čl. 8), potvrda; prije potvrde nema slanja evidencije                                                                                                                                          | B-7, F-4        | E2E; test da prije potvrde ništa ne ide na poslužitelj                   | T3       |
| F-8  | Editor u aplikaciji: naslovi, citat i bibliografija u FPZG stilu (osnovno; u demou običan tekst, bez novog čvora u shemi, D-98 dopuna), stanja spremanja "spremljeno na uređaju" i "spremljeno na poslužitelju", rad bez mreže i povratak s oznakom | F-3, B-8, K-2   | E2E: prekid mreže, nastavak, ništa izgubljeno, offline oznaka ostaje     | T3       |
| F-9  | Nastavnički pogled na rad u nastajanju i komentar uz odlomak                                                                                                                                                                                        | B-10, B-11, F-4 | E2E: komentar stiže studentu                                             | T3 do T4 |
| F-10 | Predaja, potvrda i sažetak procesa (isti prikaz za oba)                                                                                                                                                                                             | B-12, B-13      | E2E: predaja, potvrda, isti sažetak                                      | T4       |
| F-11 | Brz put za nastavnika (D-80): tekst rada, četiri retka, stanje zapisa, sortiranje po prezimenu                                                                                                                                                      | B-11, F-9       | E2E; nema sortiranja po brojevima                                        | T4       |

##### Kratkotrajne sesije i Daniel

| ID  | Zadatak                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Ovisi o        | Gotovo kad                                        | T   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------- | --- |
| K-1 | B0.4 prepis `docs/ARCHITECTURE.md` (sesija Arhitektura)                                                                                                                                                                                                                                                                                                                                                                                                                                         |                | PR spojen                                         | T1  |
| D-1 | S8 dizajnerski sustav i ekrani demoa po prototipu (sesija Dizajn)                                                                                                                                                                                                                                                                                                                                                                                                                               |                | Design artifact objavljen                         | T1  |
| D-2 | Daniel komentira dizajn; Dizajn sesija ispravlja; Daniel odobrava                                                                                                                                                                                                                                                                                                                                                                                                                               | D-1            | Daniel napiše "odobreno"                          | T1  |
| K-2 | Citatni stil (D-83): FPZG stil kopiran iz Lekte (`katedra-lite/references/fakulteti/fpzg.json`, `fpzg-diplomski/references/stranice-i-izvori.md`) u konfiguracijsku datoteku Ductusa; čista funkcija za citat u tekstu i bibliografiju                                                                                                                                                                                                                                                          | P-1            | Testovi s primjerima iz Lekte zeleni              | T2  |
| K-3 | Izmišljeni podaci demoa: fakultet, kolegij, zadatak, nastavnik, dva studenta, i dvije povijesti koje Ductus ne može razlikovati (samostalan uvezeni tekst i postupno pretipkan tuđi tekst) s objašnjenjem granica zapisa (D-80 točka 3)                                                                                                                                                                                                                                                         | B-7, B-8       | Skripta puni bazu; nijedan stvarni osobni podatak | T3  |
| K-4 | E2E prolaz demoa 1 do 5 kao jedan Playwright test s videom. Nastaje u T2 s prvim korakom i raste postupno (§7 t. 2); završni rok ostaje T4. Do 1. 11. obvezan je samo na Chromiumu; Firefox i WebKit su informativni (D-98 dopuna)                                                                                                                                                                                                                                                              | F-10, P-5, K-3 | Zelen u CI-ju; video priložen                     | T4  |
| D-3 | Proba demoa u subotu 31. 10.: Daniel prolazi demo sam, zapisuje primjedbe. Prijava ne stvara ulogu nastavnika: `pnpm local:up` prije pokretanja aplikacije daje je samo računu `Demo nastavnik` (`db/local/demo-k3.sql`, ista dodjela kao `db/local/provision-demo-teacher.sql`). Nakon `pnpm local:prepare` i prve prijave računa ulogu daje `node scripts/local/provision-teacher.mjs` (za `Demo nastavnica` s argumentom `demo-teacher-2`) ili `pnpm local:bootstrap-accounts` za oba računa | K-4, P-7       | Primjedbe poslane orkestratoru                    | T4  |
| D-4 | Snimka prolaza 1 do 5 za sastanak                                                                                                                                                                                                                                                                                                                                                                                                                                                               | D-3            | Snimka postoji                                    | T4  |

#### 5. Rezovi ako se kasni

Redoslijed je odobren (D-87). Primjenjuju se redom, tek na kontrolnoj točki, kad orkestrator utvrdi kašnjenje; Daniel dobiva obavijest uz svaki primijenjeni rez. **Stanje 11. 10. 2026. (D-105; issue #87, komentar 6105201573):** zasad se ništa ne reže; rok srijeda 14. 10. za #206 je točka u kojoj orkestrator ponovno iznosi stanje, ne automatski rez. Već primijenjeno iz D-98 time nije promijenjeno. Redoslijed rezova:

1. Dvije izmišljene povijesti (K-3, dio za D-80 točku 3) prikazuju se kao unaprijed pripremljen primjer umjesto u živom prolazu.
2. Brz put za nastavnika (F-11) ide nakon demoa; nastavnik vidi rad i sažetak kroz F-9 i F-10.
3. Bibliografija samo u jednom obliku izvora (knjiga), citat u tekstu ostaje.
4. Video iz CI-ja zamjenjuje Danielovu snimku (D-4).

Ne režu se: rekonstrukcija i blokada nepodudarne predaje, isti sažetak za oba, rad bez mreže, pgTAP matrica, provjera zabranjenih riječi.

#### 6. Kad se planira ostatak vala 1

Detaljan plan faze nastaje tek kad je okidač ispunjen; do tada vrijedi tablica faza iz `PROGRAM.md`.

| Faza                                                                            | Okidač za detaljan plan                                                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| M1 AAI                                                                          | FPZG ovlasti Daniela za AAI@EduHr Lab (nakon demoa)                                                                   |
| M2 ostatak (komentor, povjerenstvo, pravno zadržavanje, jezik rada, mentorstvo) | Demo spojen; D-16 potvrđen                                                                                            |
| M3 ostatak (lijepljenje s oznakom, vrsta dokaza, spike programskog unosa D-54)  | Demo spojen; B0.2 izmjeren                                                                                            |
| M4 Lekta paket                                                                  | Odluka o licenci Lekte                                                                                                |
| M5 do M7 ostatak                                                                | Demo spojen i Danielove primjedbe s probe; D-34 za izravne izmjene                                                    |
| M10 Podaci                                                                      | D-30 (rokovi čuvanja) od FPZG-a                                                                                       |
| M11 GO uvjeti                                                                   | dio D-08 o dobavljačima i trošku potvrđen nakon B0.1 (i B0.2, odnos nije odlučen; vidi `STATE.md`); računi dobavljača |

#### 7. Kritični put i rezerva [ODLUČENO D-98]

Potvrđeno 10. 10. 2026. (Daniel). Dopunjuje §3 do §5; gdje se razlikuju (K-4 u §4 vodi se kao zadatak T4, B-12 ovisi o B-8, a ne o B-9), vrijedi ovaj odjeljak.

**Nalaz.** Lanac B-8 → B-9 → B-12 → F-10 → K-4 (nakon dopune D-98 od 10. 10. 2026. za demo: B-8 → B-12 → F-10 → K-4, bez B-9) cijeli pada u T3 i T4, a proba D-3 je zadnji dan T4. Rezovi iz §5 skidaju točke 6 do 8 i snimku; nijedan ne skraćuje taj lanac. Kašnjenje bilo kojeg zadatka u lancu zato izravno pomiče demo.

**Odluka:**

1. **Tanki prolaz do kontrolne točke T2 (18. 10.).** `ingest` jednog odsječka, rekonstrukcija i JCS usporedba prolaze od početka do kraja nad in-memory adapterima i razvojnim potpisnikom, bez sučelja. Zadatak je B-14 u §4 (Backend; ovisi o B-3 i B-4). B-8, B-9 i B-12 zatim zamjenjuju dijelove tog prolaza pravima, umjesto da se prvi put spoje u T4.
2. **K-4 raste postupno.** E2E prolaz demoa nastaje u T2 kao test s prvim korakom (prijava) i dobiva korak uz svaki spojeni zadatak iz F-6 do F-10. U T4 ostaje samo zadnji korak i video. Završni rok K-4 se ne mijenja: ostaje T4, kao u §4.
3. **Zamrzavanje opsega u srijedu 28. 10.** Zamrzavanje znači zabranu novog opsega: nakon 28. 10. ne ulazi ništa što nije u tablici §4. Zadaci koje tablica §4 već raspoređuje u T4 (B-12, B-13, F-10, K-4 i P-7; prema tablici i F-11 te završeci B-11 i F-9) smiju se dovršiti i spojiti do kraja T4. Uz njih se spajaju samo popravci. Radna proba je u četvrtak 29. 10.; proba 31. 10. (D-3) ostaje kao završna.
4. **Rez kritičnog puta, prije rezova iz §5.** Primjenjuje se odmah (vlasnik, 10. 10. 2026.; D-98 dopuna), ne tek uz kašnjenje; B-9 izlazi iz demoa. Potpis potvrde i rekonstrukcija za demo izvode se u istom procesu, iza istih sučelja, a pg-boss worker (B-9) i stanje `pending_signature` idu odmah nakon demoa. Taj proces je web proces (Next.js) lokalnog demo stoga, s razvojnim Ed25519 potpisnikom iz B-4. Popis "ne režu se" iz §5 ostaje netaknut.

   Odstupanja, samo za demo s razvojnim ključem:

   - **Potpis:** D-71, `docs/BACKEND.md` §3 pravilo 3 i `docs/ARCHITECTURE.md` §8 i §10 traže da web proces ne drži materijal ključa i da potpisuje samo worker. U demou web proces drži razvojni ključ i potpisuje.
   - **Red poslova:** D-74 i BACKEND §4.5 stavljaju pg-boss u worker, a BACKEND §3 pravilo 3 vodi `pending_signature` kao normalan tok. U demou nema ni reda poslova ni tog stanja.
   - **Rekonstrukcija:** B-12 (§4), BACKEND §4.6 i ARCHITECTURE §6 t. 3 traže rekonstrukciju u workeru. U demou se izvodi u web procesu.

   Odstupanje ne vrijedi ni za jedno okruženje sa stvarnim podacima. BACKEND i ARCHITECTURE se zbog njega ne mijenjaju i ostaju mjerodavni za sve osim ovog demoa; brava koja sprječava razvojni potpisnik u produkciji (ARCHITECTURE §8 i §9) ostaje. PR koji provodi t. 4 otvara se kao `Risk: critical` (`docs/ENGINEERING_SYSTEM.md` §5: potpisi, rekonstrukcija, predaja).

### Program proizvoda i programske obveze

Prilog zahtjeva iz [izvorne revizije](https://github.com/ductura/.github/blob/265ea93a2e14a22902e17d259e31304278c30982/docs/ductus/PROGRAM.md). Datirani rasporedi i povijesni opisi služe sljedivosti.

Verzija 0.5 · 4. 11. 2026. · Odgovorna osoba: Daniel Rišavi

**D-191 (30. 10. 2026.):** cilj rada su sve faze M0 do M11. Demo je odgođen bez datuma, a datumi pilota i rasporeda po valovima u ovom dokumentu nisu obvezujući dok vlasnik ne odluči novi raspored. Novi raspored je D-199 t. 6 (ODLUČENO 1. 11. 2026.): kod vala 1 spreman 22. 2. 2027., pilot 1. 3. 2027.; datumi u odjeljcima ispod koji su stariji od te odluke ostaju povijesni zapis. D-203 (ODLUČENO 1. 11. 2026., E3) mijenja datum pilota: nakon koda spremnog 22. 2. 2027. slijedi puna tehnička proba od oko četiri tjedna, a nastavna aktivacija dolazi tek nakon uspješnog prihvata i suglasnosti FPZG-a, oko 22. 3. 2027. ili poslije. Datum 1. 3. 2027. ostaje kao trag prethodnog cilja. Razrada svake faze na korake, bez datuma, je u `docs/PROGRAM-RAZRADA.md`.

**D-266 (ODLUČENO 4. 11. 2026.):** datum pilota je prema D-203 E3: kod vala 1 spreman 22. 2. 2027., zatim tehnička proba od oko četiri tjedna, a nastava oko 22. 3. 2027. ili kasnije, nakon prihvata i suglasnosti FPZG-a; 1. 3. 2027. je samo trag. Cilj razvoja ostaje M0 do M11 (D-191), a M12 je faza provedbe pilota, ne razvoja. Rok M9.1 je 15. 12. 2026. (Q-10 A). GO tablica ima 16 redaka (Q-7 A).

Faze idu redom po ovisnostima. Faza je gotova tek kad je njezin izlazni kriterij dokazan testom ili zapisom, ne kad je kod napisan. Procjene su u večerima rada (oko 3 sata) jedne osobe uz AI agente i služe samo za planiranje.

Paralelno s fazama teče tvoj red (`STATE.md`, Owner queue): Srce, FPZG, pravni dio, Lekta. Taj red ne čeka kod i kod ne čeka njega dok ne dođu GO uvjeti.

#### Rok

- Ljetni semestar 2026./2027.: prema okvirnom kalendaru Sveučilišta u Zagrebu nastava počinje 22. 3. 2027. FPZG ima vlastiti kalendar; točan datum potvrditi s fakultetom (akademski kalendar je u paketu zahtjeva FPZG-u, D-264 Q09).
- Tehnička proba (faza A) počinje kad je kod vala 1 spreman, **22. 2. 2027.**, i traje 4 puna tjedna. Nastava (faza B) počinje oko 22. 3. 2027. ili kasnije.
- Od 3. 10. 2026. do 22. 2. 2027. ima oko 20 tjedana.
- **D-203 E3:** 22. 2. 2027. ostaje cilj spremnosti koda vala 1. Puna tehnička proba se ne skraćuje radi datuma, a nastavna aktivacija čeka uspješan prihvat i suglasnost FPZG-a.
- **Tri faze pilota (D-203 E3, D-266 t. 8; M12):** **A** tehnička proba sa sintetičkim radovima od 22. 2. 2027., traje 4 puna tjedna i ne skraćuje se radi datuma. **B** nastava oko 22. 3. 2027. ili kasnije, tek nakon uspješnog izlaza A i suglasnosti FPZG-a. **C** evaluacija nakon 4. 6. 2027. (točan datum potvrditi s FPZG-om). Datum 1. 3. 2027. je samo trag.

#### Faze

Backend (hosting, prijava, evidencija, korijen i žig, operacije) razrađen je u `docs/BACKEND.md` §8 kao okomiti rez kroz ove faze; dodatak realno 18 do 25 večeri (zaseban red u valu 1) uz spikeove B0.1 i B0.2 prije M2.

| Faza                                                    | Sadržaj                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Izlazni kriterij                                                                                                                                                                                                                                                                                                                                                                                                                | Procjena                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **M0 Temelj**                                           | Prijenos jezgre iz `pisac-editor` s testovima; CI (lint, typecheck, unit, property, E2E, axe, Gitleaks, zizmor, Semgrep, OSV); lefthook; `docker compose` okruženje (Postgres, S3-kompatibilna pohrana, Mailpit, lažni OIDC; MinIO više nema sliku, lokalno RustFS) u CI-ju; kod iza sučelja dok dio D-08 o dobavljačima i trošku nije potvrđen                                                                                                                                   | Svi preneseni testovi zeleni; za svaki neprenesen izvorni test zapisan Ductus test koji ga pokriva, a nepokriveno vraćeno kao test (odluka vlasnika 31. 10. 2026., #87 c.6547174354); CI zelen na `main`                                                                                                                                                                                                                        | 2 do 3                         |
| **M1 AAI spike**                                        | Prijava preko AAI@EduHr Laba kroz vlastiti OIDC klijent (D-73); provjera da nema spajanja računa po e-pošti i mapiranja hrEdu atributa; lažni pružatelj za CI; prije prvih stvarnih računa model računa za drugog izdavatelja identiteta (D-104, `critical`, uz plan napada; D-09 nepromijenjen)                                                                                                                                                                                  | **Tehnički M1** (D-203 t. 4): spojeni koraci M1.3 do M1.8; `app_user` vezan uz `hrEduPersonUniqueID`; test dokazuje da lažni pružatelj ne postoji u produkciji; model računa nije tvrdo vezan uz jedan izdavatelj (D-104). **Prije stvarne uporabe:** prijava na Labu radi (M1.1, M1.2), uz staging M11.4 i GO uvjete. Lažni OIDC i CI nisu dokaz stvarnog AAI toka (D-203 D1)                                                  | 1 do 2                         |
| **M2 Model fakulteta**                                  | Fakultet, kolegij, članstvo, zadatak i verzije zadatka, potvrda obavijesti, mentorstvo, uloge, pravilo AI-ja kolegija (D-52), oznaka prilagodbe (D-50); upis kodom; pgTAP matrica pristupa                                                                                                                                                                                                                                                                                        | Matrica pristupa zelena za sve kombinacije uloga, uključujući mentora                                                                                                                                                                                                                                                                                                                                                           | 4 do 5                         |
| **M3 Evidencija**                                       | Sažimanje transakcija u odsječke s autorom, ruta `ingest`, hash lanac, kontrolne točke, praznine, offline oznaka, oznaka lijepljenja (D-43), vrsta dokaza (D-44), spike programskog unosa (D-54); journal vezan uz korisnika i brisanje sinkroniziranog zapisa pri odjavi (D-118)                                                                                                                                                                                                 | Property testovi: izmjena, brisanje ili preslagivanje odsječka ruši provjeru; idempotentno ponovno slanje; oporavak prekida između Storagea, RPC-a i potpisa; izmjereno CPU vrijeme rekonstrukcije doktorskog rada                                                                                                                                                                                                              | 7 do 9                         |
| **M4 Lekta paket**                                      | U Lekti: generirani paket pravila po uzoru na `katedra-pack` (FPZG profili, pravila oblika, citatni stilovi, predlošci naslovne stranice). U Ductusu: učitavanje profila i provjera oblika nad dokumentom editora                                                                                                                                                                                                                                                                 | FPZG profili učitani iz paketa s verzijom; test zanošenja (drift) u Lekti; provjera oblika javlja odstupanja na testnim radovima                                                                                                                                                                                                                                                                                                | 8 do 12                        |
| **M5 Akademski editor**                                 | Numerirani naslovi, sadržaj, naslovna stranica i izjava, fusnote, tablice, slike s opisima, popisi tablica i slika, citiranje u tekstu, bibliografija u stilu fakulteta; provjera postojanja DOI-ja i URL-a (D-48, val 2); opseg po poglavlju (D-60), bilježnica izvora (D-59, uvoz iz Zotera u valu 2), poziv na prikaze, hrvatski navodnici, traži i zamijeni, fokus                                                                                                            | Testni rad od 15.000 riječi sa svim elementima uređuje se bez gubitka; citati i bibliografija usklađeni; napredak studenta iz verzija (D-63)                                                                                                                                                                                                                                                                                    | 19 do 26                       |
| **M6 Suradnja**                                         | Prikaz uživo za nastavnika (kanal zadnjeg stanja po D-142, `docs/BACKEND.md` §4.12; polling iz D-74 vrijedi samo za obavijesti), komentari vezani uz odlomak, prijedlozi izmjena, izravne izmjene s pripisivanjem, pravilo D-34; val 2: zahtjev za doradu (D-45), odgođeno objavljivanje (D-51), konzultacije (D-47)                                                                                                                                                              | Komentar i prijedlog stižu studentu bez osvježavanja; svaka izmjena nastavnika pripisana u evidenciji; nema izgubljenih promjena kad oboje rade; izmjena prihvaćenog odlomka ponovno otvara pregled                                                                                                                                                                                                                             | 17 do 24                       |
| **M7 Predaja i sažetak**                                | Obavijest (S3), ciklusi verzija, pregled prije predaje, zamrzavanje, rekonstrukcija, potvrda, sažetak procesa, usporedba verzija, produljenje roka, izjava po FPZG čl. 9 i 15 (D-40); val 2: prenosiv zapis s QR provjerom (D-49)                                                                                                                                                                                                                                                 | Rekonstrukcija podudarna na svim scenarijima, uključujući prazninu; nepodudarnost blokira predaju; student i nastavnik vide isti sažetak; nema zabranjenih riječi; rok testiran preko promjene sata; izjava sadrži sve zabilježene stavke; karta podrijetla bez zbroja (D-57); otvorena mjesta (D-61) i pravila zadatka s kontrolnim popisom (D-62) bez oznaka prolaza; valovi M7.Z1 i M7.Z2 u odjeljku „Valovi M7” (D-263 Q15) | 15 do 20                       |
| **M8 Uvoz i izvoz**                                     | Uvoz DOCX-a i PDF-a kao označen događaj; izvoz DOCX-a, PDF-a i PDF/A u obliku fakulteta (izvoz u valu 1, D-203 A3)                                                                                                                                                                                                                                                                                                                                                                | Uvoz označen u evidenciji; izvoz DOCX, PDF i PDF/A prihvaćen prije nastavnog pilota; PDF/A-2u prolazi provjeru veraPDF-om (`isCompliant="true"`), a obični PDF nije označen kao PDF/A (D-206, D-203 A3); izvezeni DOCX prolazi Lektinu provjeru za FPZG profil kad stigne licenca Lekte, a do tada izvoz radi bez provjere oblika (D-203 t. 2)                                                                                  | 6 do 8; PDF/A nije procijenjen |
| **M9 AI pomoćnik** (u pilotu, D-194; mijenja D-77)      | Pristup pomoćniku preko računa kod pružatelja (model računa i pružatelj su otvoreni, D-194 t. 6 i 7), popis dopuštenih pružatelja po fakultetu i zadatku bez kineskih pružatelja i modela (D-194 t. 2), sve namjene iz D-64 uključujući transkripciju i alate pružatelja (D-194 t. 4), prenošenje teksta s bilježenjem pružatelja, modela i svrhe (D-42), razgovori uz izjavu (D-41), zaštita sadržaja pri lekturi (D-46), poznato podrijetlo i podudaranje s AI odgovorom (D-58) | Nedopušten pružatelj nije dostupan; svako prenošenje u evidenciji; nepriloženi razgovori nisu vidljivi nastavniku; promijenjena brojka ili citat prikazani prije primjene; prepisan AI odgovor označen; svrhe razine 2 nedostupne dok ih nastavnik ne uključi, pomoćnik koji pita (D-64)                                                                                                                                        | 14 do 19                       |
| **M10 Podaci**                                          | Klase podataka, brisanje po roku, izvoz za studenta i za bivšeg studenta preko referade (referada provjerava identitet, admin ustanove pokreće posao s referencom, jednokratna poveznica na 24 h; D-271 MQ02)                                                                                                                                                                                                                                                                     | Brisanje po roku testirano; lanac ostaje provjerljiv nakon brisanja sadržaja                                                                                                                                                                                                                                                                                                                                                    | 3                              |
| **M11 GO uvjeti**                                       | Produkcijski okoliš u EU-u (D-08), staging s AAI@EduHr Labom, proba povrata iz kopije, DPIA i ugovor o obradi, obavijest o privatnosti, pristupačnost, `docs/OPERATIONS.md`                                                                                                                                                                                                                                                                                                       | Sve stavke iz tablice GO uvjeta zelene i zapisane                                                                                                                                                                                                                                                                                                                                                                               | 3 + vanjski rokovi             |
| **M12 Pilot** (provedba pilota, ne faza razvoja; D-266) | Faza A tehnička proba, faza B nastava, faza C evaluacija                                                                                                                                                                                                                                                                                                                                                                                                                          | Pragovi korisnosti i razumijevanja iz `PRODUCT.md` §12 zapisani prije faze A (GO t. 11, Q-12 A); mjerila izmjerena i zapisana                                                                                                                                                                                                                                                                                                   | Ljetni semestar                |

**Zbroj prema tablici: 99 do 134 večeri** (69 do 93 prije dodataka D-40 do D-64). Procjene ovakvih projekata u pravilu se prekorače, pa je realan raspon **145 do 195 večeri**. Cijeli opseg ne stane u jedan semestar pripreme; zato vrijede valovi i kontrolna točka niže.

#### Demo za fakultet [PRIJEDLOG D-76]

**Odgođeno bez datuma (D-191).** Odjeljak ostaje kao zapis opsega prvog prolaza.

Sastanak s FPZG-om održava se kad je demo gotov. Demo je prvi dio pravog sustava, ne zaseban prototip.

**Jedan prolaz od početka do kraja, na izmišljenom zadatku:**

1. Nastavnik stvara kolegij i zadatak (s obaviješću studentu, S3).
2. Student piše u pravom editoru (naslovi, citat, bibliografija u osnovnom obliku); stanja spremanja su stvarna, uključujući rad bez mreže i povratak.
3. Nastavnik vidi spremljeno stanje rada i ostavlja komentar vezan uz odlomak.
4. Student predaje; poslužitelj rekonstruira rad, usporedba se podudara, student dobiva potpisanu potvrdu.
5. Student i nastavnik vide isti sažetak procesa; nema zabranjenih riječi ni postotaka.
6. Brz put za nastavnika (D-80): tekst rada, četiri retka i stanje zapisa, isto kao kod studenta.
7. Prvi ekran zadatka citira dopuštene i zabranjene uporabe iz FPZG čl. 8 (D-80).
8. Dvije izmišljene povijesti koje Ductus ne može razlikovati (samostalan uvezeni tekst i postupno pretipkan tuđi tekst), uz objašnjenje granica zapisa (D-80).

**Namjerno izvan demoa:** AAI prijava (lažni OIDC pružatelj s jasnom oznakom "demo prijava"), AI pomoćnik, Lekta paket osim jednog citatnog stila, uvoz i izvoz, dnevni korijen, mentorski radovi, reprodukcija.

**Gdje radi:** na tvom računalu (Docker) za sastanak; javna staging adresa samo ako je B0.1 već odrađen, kako se kod ne bi vezao uz dobavljača prije potvrde dijela D-08 o dobavljačima.

**Izlazni kriterij:** prolaz 1 do 5 snimljen, E2E test tog prolaza zelen u CI-ju, nijedan stvarni osobni podatak.

**Procjena:** oko 18 do 26 večeri (M0, B1 osnovno, dijelovi M2, M3, M5, M6, M7 iz vala 1). Uz puno radno vrijeme oko 3 do 4 tjedna od početka M0, dakle cilj **početak studenog 2026.**, ovisno o spajanju `pisac-editor` PR #49 i #50 i lokalnom stroju s Dockerom.

Ovo nije dodatni posao: sve stavke su dio vala 1 i samo su poredane tako da prvi prikaz bude rano. Kontrolnu točku 15. 12. 2026. zamjenjuje kontrolna točka 20. 12. 2026. (D-203 t. 5); kontrolne točke 30. 11. 2026. i 15. 1. 2027. ostaju. Na svakoj od njih vlasnik bira varijantu plana prema izmjerenoj brzini (D-203 t. 1, D-280 Q-17 A).

#### Raspored po valovima [ODLUČENO D-36, verzija 2]

**Povijesni zapis od D-191 (30. 10. 2026.).** Datumi, kapacitet, kontrolne točke 15. 12. i 16. 11. 2026. te okidač rezova u ovom odjeljku ne vrijede dok vlasnik ne odluči novi raspored. Odluke D-36, D-99 i D-100 ostaju zapisane; redoslijed rada sada je u `docs/PROGRAM-RAZRADA.md`.

U pilot ulazi sve prihvaćeno (D-26, D-65), ali ne odjednom. Faze M0 do M11 iz tablice gore dijele se po valovima; ovdje je što točno ide u koji val.

##### Kapacitet

Od 3. 10. 2026. do 22. 2. 2027. ima 20 tjedana, od toga oko 2 tjedna blagdana. Uz prekoračenje procjena od oko 40 %:

| Večeri tjedno za Ductus                               | Stvarnih večeri do 22. 2. | Nominalno (nakon prekoračenja) |
| ----------------------------------------------------- | ------------------------- | ------------------------------ |
| 3                                                     | oko 54                    | oko 38                         |
| 4                                                     | oko 72                    | oko 51                         |
| 5                                                     | oko 90                    | oko 64                         |
| 6                                                     | oko 108                   | oko 77                         |
| Puno radno vrijeme (oko 10 jedinica od 3 sata tjedno) | oko 180                   | oko 130                        |

Od 3. 10. 2026. vlasnik radi na Ductusu puno radno vrijeme. Uz oko 10 jedinica tjedno (dvije dnevno, pet dana; ostalo vrijeme za druge projekte i odmor) do 22. 2. 2027. ima oko 130 nominalnih večeri, a **val 1 i val 2 zajedno traže 102 do 137 nominalnih večeri** (zbroj tablica niže, D-99). Donja granica stane uz oko 28 večeri rezerve; gornja prelazi kapacitet za oko 7. Cilj ostaje pustiti val 1 i val 2 na početku semestra, a val 3 tijekom semestra (D-36). Stane li opseg, provjerava se na kontrolnim točkama (D-100); ako val 2 kasni, pomiče se najkasnije do sredine svibnja; val 1 se zbog vala 2 ne skraćuje, nego samo rezovima iz kontrolne točke (D-100). Procjena od 10 jedinica tjedno je namjerno konzervativna: rad bez pauza ruši kvalitetu i rokove.

###### Provjera zbroja [ODLUČENO D-99]

Potvrđeno 10. 10. 2026. (Daniel). Odlomak iznad, tablica vala 1 i kontrolna točka 15. 12. 2026. usklađeni su s ovim računom.

- Val 1 prema tablici niže: 56 do 74 bez backend dodatka; s dodatkom od 18 do 25 večeri (`docs/BACKEND.md` §8) **74 do 99**.
- Val 2 prema tablici niže: **28 do 38**.
- Val 1 i val 2 zajedno: **102 do 137**, naspram oko 130 nominalnih večeri do 22. 2. 2027. Raniji tekst navodio je 94 do 124, a tablice bez backend dodatka davale su 84 do 112.
- **Nakon D-203 (1. 11. 2026., NEPROVJERENO):** val 1 **84 do 113**, val 2 **19 do 28**, zajedno **103 do 141**, sve bez M9 i uz neprocijenjeni V11. Zbrojevi iznad ostaju kao zapis D-99.
- Do kontrolne točke 15. 12. 2026. (povijesno; zamijenjena točkom 20. 12. 2026., D-203 t. 5) ima oko 75 nominalnih večeri; val 1 bez M11 (5 do 6) traži **69 do 93**.
- Faktor prekoračenja: M0 je procijenjen na 2 do 3 večeri, a 10. 10. 2026. `STATE.md` ga i dalje vodi kao trenutnu fazu. Na svakoj kontrolnoj točki zapisuju se stvarno utrošene jedinice po fazi i iz njih se izvodi faktor prekoračenja, umjesto pretpostavljenih 40 % s kojima računa tablica kapaciteta gore.
- **Otvoreno pitanje: sastav backend dodatka (riješiti prije provjere 16. 11. 2026.).** Dodatak od 18 do 25 večeri nije razložen po koracima ni po fazama. Retci s procjenom u `docs/BACKEND.md` §8 zajedno daju 26 do 39 večeri. Među njima je B5 (4 do 5), koji ima i vlastiti redak u valu 2, i B9 (3 do 4), koji pripada M11. Ako dodatak sadrži B5, zbroj 102 do 137 broji ga dvaput; ako sadrži B9, "val 1 bez M11" (69 do 93) sadrži dio M11. Brojke 74 do 99, 102 do 137 i 69 do 93 prihvaćene su u D-99 i ovdje se ne mijenjaju, ali ovise o ovom pitanju.

##### Val 1: početak ljetnog semestra (kod spreman oko 22. 2. 2027.)

Radovi: podnesci i eseji. AI pomoćnik M9 ulazi u ovaj val (D-199 t. 1, zamjenjuje raniju rečenicu „Bez AI pomoćnika u ovom valu”), ali ga zadatak i dalje ne smije tražiti (D-38). M9 nije u tablici ni u zbroju ispod; raspored koji ga uklapa do 1. 3. 2027. je D-199 t. 6 (ODLUČENO, D-191 t. 2). Dio M8 iz D-198 t. 1 (čitanje verzija iz clouda) prema tom rasporedu seli iz vala 2 u val 1; dodaci za Word i Google Docs idu u sljedeći val (D-198 t. 2). Mentori mogu pratiti završne radove osnovnim nastavničkim funkcijama.

Prema D-203 (ODLUČENO 1. 11. 2026.) val 1 dobiva i: izvoz DOCX, PDF i PDF/A (A3); cijeli tok nastavničkih izmjena po D-34, bez novog modela istodobnog uređivanja (B1); puni B5 prije nastavnog pilota (C2); shemu v2 (DAN-453) i funkcije V11 koje pripadaju fazama vala 1: osnovni editor, komentari, D-34 i izvoz (D-201, D-203 t. 6). Ostale funkcije V11 idu u val 2 i 3 prema fazama M5 do M9. M2 napreduje uz sintetičke identitete, a stvarni AAI ostaje kriterij prije stvarne uporabe (D1). Retci D-203 su ispod zbroja D-99.

| Dio                                       | Sadržaj                                                                                                                                                                                          | Procjena                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| M0, M1                                    | Temelj i AAI@EduHr (M1 ovisi o pristupu Labu Srca; do tada lažni pružatelj)                                                                                                                      | 3 do 5                              |
| M2                                        | Model fakulteta s rupama: komentor, povjerenstvo, pravno zadržavanje, jezik rada, pravilo AI-ja kolegija, prilagodba                                                                             | 5 do 6                              |
| M3                                        | Evidencija, oznaka lijepljenja (D-43), vrsta dokaza (D-44), spike programskog unosa (D-54), bilježenje ritma za mentorske radove ako je D-56 odobren                                             | 8 do 10                             |
| M4 osnovno                                | Lekta paket: FPZG citatni stil, opseg, naslovna stranica                                                                                                                                         | 4 do 6                              |
| M5 osnovno                                | Naslovi, citiranje, bibliografija, DOI i ISBN (S-08), opseg po poglavlju (D-60), pravopis po jeziku rada (S-07), navodnici, traži i zamijeni, osnovna bilježnica izvora (D-59)                   | 9 do 12                             |
| M6 osnovno                                | Pogled na rad u nastajanju, komentari, prijedlozi                                                                                                                                                | 6 do 8                              |
| M7 osnovno                                | Obavijest S3, predaja, rekonstrukcija, sažetak procesa, izjava D-40 s AI dijelom (D-199 t. 1), produljenje roka                                                                                  | 8 do 10                             |
| M10 osnovno                               | Klase podataka, brisanje po roku, pravno zadržavanje (F-02)                                                                                                                                      | 2 do 3                              |
| M11                                       | GO uvjeti, sučelje na engleskom (D-70), pristupačnost (F-03), statusna stranica (F-10)                                                                                                           | 5 do 6                              |
| Uz to                                     | Obavijesti (N-01), podsjetnici (N-02), popis "tko treba pomoć" (N-12), uvodni vodič (S-11)                                                                                                       | 6 do 8                              |
| Backend dodatak                           | Okomiti rez kroz faze vala 1 prema `docs/BACKEND.md` §8 (D-99)                                                                                                                                   | 18 do 25                            |
| **Ukupno**                                |                                                                                                                                                                                                  | **74 do 99**                        |
| M6 nastavničke izmjene (D-203 B1)         | Prijedlog koji primjenjuje studentov klijent, jedan pisac (D-34): ovlasti, pripisivanje, povijest, prikaz, scenariji sukoba i neuspjeha; dijelom se preklapa s „prijedlozima” u retku M6 osnovno | 3 do 4, NEPROVJERENO                |
| M8 izvoz (D-203 A3)                       | Izvoz DOCX, PDF i PDF/A; provjera oblika FPZG-a kad stigne licenca Lekte (t. 2)                                                                                                                  | 3 do 5, NEPROVJERENO                |
| B5 (D-203 C2)                             | Dnevni korijen i žig, CLI verifikator (D-72), seli iz vala 2                                                                                                                                     | 4 do 5                              |
| Shema v2 i V11 vala 1 (D-201, D-203 t. 6) | Proširenje kanonske sheme (DAN-453) i funkcije V11 za osnovni editor, komentare, D-34 i izvoz                                                                                                    | nije procijenjeno                   |
| **Ukupno s D-203**                        | Bez M9, dijela M8 iz D-198 i AI dijela izjave (D-199 t. 6)                                                                                                                                       | **84 do 113** uz neprocijenjeni V11 |

##### Val 2: proširenje seminarskih radova (cilj: početak semestra; najkasnije sredina svibnja 2027.)

| Dio                     | Sadržaj                                                                                                                                                                           | Procjena                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| M5 ostatak              | Fusnote, tablice, slike, pozivi na prikaze                                                                                                                                        | 5 do 7                                      |
| M6 ostatak              | Zahtjev za doradu (D-45), odgođeno objavljivanje (D-51), banka komentara (N-03), promjene od zadnjeg pregleda (N-05); izravne izmjene (D-21) po toku D-34 sele u val 1 (D-203 B1) | 5 do 8, NEPROVJERENO (prije D-203: 8 do 11) |
| M7 ostatak              | Karta podrijetla (D-57), otvorena mjesta (D-61), pravila zadatka i kontrolni popis (D-62)                                                                                         | 5 do 7                                      |
| M8                      | Uvoz DOCX-a; izvoz seli u val 1 (D-203 A3)                                                                                                                                        | 2 do 3, NEPROVJERENO                        |
| Izjava o vanjskom AI-ju | Ispis razgovora iz vanjskog alata uz izjavu po čl. 15, kao izjavljeno (D-77)                                                                                                      | 2 do 3                                      |
| B5                      | Seli u val 1 (D-203 C2)                                                                                                                                                           | 0                                           |
| **Ukupno**              |                                                                                                                                                                                   | **19 do 28** (prije D-203: 28 do 38)        |

Izvan pilota (3. 10. 2026.): grupni radovi S-12 (D-78). Ugrađeni AI pomoćnik M9 ušao je u pilot 31. 10. 2026. (D-194, mijenja D-77); procjena tjedana za M9 u tablici faza gore nije uključena u zbroj iznad. M9 ide u val 1 (D-199 t. 1), pa zbroj vala 1 i oba vala zajedno bez M9 podcjenjuje potreban rad.

Razvoj vala 2 teče tijekom semestra, uz podršku pilotu. Ako kasni, val 2 se pomiče prema kraju semestra; ne skraćuje se val 1.

##### Val 3: mentorski radovi i obrana (cilj svibanj 2027., najkasnije prije prvog roka obrana)

Konzultacije (D-47), ključni rokovi (N-07), komentor i povjerenstvo u sučelju (N-08, N-09), priprema za razgovor (D-53), reprodukcija s povijesti odlomka (D-56), priprema za obranu (A-04), PDF izvori i provjera citata (S-09, A-03), uvoz PDF-a, poznato podrijetlo (D-58), provjera izvora (D-48), prenosiv zapis i paket za zaštitu (D-49, S-01), vremeplov (S-02), planer (S-06), zbirni pregled (N-11), verifikator (A-07), "moj rad u brojkama" (A-10), portfelj (S-10), izvješće za evaluaciju (F-01), mobilne bilješke (S-03, val 3 unutar kasnijeg pilot-vala; ne ulaze u valove 1–2). Procjena **50 do 65**. Raspored tih stavki po fazama M5 do M11, s uvjetnim koracima koji čekaju vlasnika, zapisan je u `docs/PROGRAM-RAZRADA.md` (odluka T3, #87 c.6544288967); D-191 je datume vala učinio neobvezujućima.

##### Valovi M7 (D-263 Q15)

Ovaj odjeljak zapisuje D-263 Q15 (#87 c.6622685877), koji traži usklađenje `docs/PROGRAM.md` zasebnim PR-om (M7.0a), i tumačenje D-266 t. 7 (#87 c.6639423372). Koraci i potkoraci (P01, P02 …) su oni iz `docs/PROGRAM-RAZRADA.md`, odjeljak M7, kako ih navodi D-263. Procjene u retcima „M7 osnovno” i „M7 ostatak” ostaju iz D-99 i ovdje se ne mijenjaju.

| Dio         | Sadržaj (riječi iz D-263 Q15)                                                                  | Rok                          | Izvor     |
| ----------- | ---------------------------------------------------------------------------------------------- | ---------------------------- | --------- |
| M7.Z1       | M7.1-P01 do P06, M7.2, M7.3, M7.4, M7.5 i M7.9-P01                                             | 5. 2. 2027.                  | D-263 Q15 |
| M7.Z2       | Runde, usporedba, karta podrijetla, kontrolni popis, dopune, prenosivi zapis, M7.9-P02 i M7.13 | nije zapisan                 | D-263 Q15 |
| Nakon M8/M9 | M7.9-P02 i M7.10-P03                                                                           | „nakon M8/M9 (15. 2. 2027.)” | D-263 Q15 |

- **Koraci M7.Z2 po nazivu:** D-263 Q15 navodi dijelove M7.Z2 nazivom, a izričito imenuje samo M7.7 (uz SUB-LOCAL). Runde su M7.1-P07 (D-263 Q08). U tablici koraka M7 u `docs/PROGRAM-RAZRADA.md` nazive nose M7.6 (usporedba), M7.7 (karta podrijetla, kontrolni popis), M7.8 (dopuna) i M7.10 (prenosiv zapis).
- **Izjava u M7.Z1:** do 5. 2. 2027. izjava (M7.5) ima AI odjeljak nad zatvorenim formatom priloga. M9.5 dolazi nakon M7.5, do 15. 2. 2027., i daje proizvođača priloga i integracijski dokaz; izjava bez AI dijela ne vraća se u val 1 (D-266 t. 7). Popis dopuštenih vanjskih formata zatvara se prije koda (M7.5-P02, D-263 Q22).
- **Runde:** expand migracija za runde (M7.1-P07) nije potrebna prije M7.1-P01 do P06 (D-263 Q08).
- **Rekonstrukcija u workeru:** DAN-517 i DAN-518 (worker) idu prije DAN-381 (M7.1) (Q-4, #87 c.6639423372; D-261 Q02).
- **Referentne slike:** UI PR-ovi M7 čekaju vlasnikovo odobrenje slika M7.UX-R, backend ne čeka (D-263 Q16); slike se odobravaju po ekranu čim prođu gate (Q-8, #87 c.6639423372).
- **SUB-LOCAL:** vezan je uz M7.7, koji je u M7.Z2; da SUB-LOCAL time ne klizi, osigurava orkestrator (D-263 Q15).
- **Jezik:** M7 je samo na hrvatskom; engleski ulazi s M11 (D-263 Q28).
- **Uvjetni koraci:** M7.6-P03, M7.11 i M7.12 ne grade se bez potvrde FPZG-a i C-42, pravnog mišljenja (D-55, C-19), odnosno U-3 (D-263 Q27). D-263 Q15 ih ne navodi ni u jednom dijelu.
- **Izlaz:** izlazni kriterij M7 u tablici faza se ne mijenja. Karta podrijetla (D-57), otvorena mjesta (D-61) i kontrolni popis (D-62) dio su tog kriterija, a M7.7 je u M7.Z2 (D-263 Q15), pa završetak M7.Z1 sam ne dokazuje izlazni kriterij M7.

**Otvoreni neskladi (Q-19 A, #87 c.6639423372: do odluke vrijede zapisane odluke, neskladi ostaju otvoreni):**

1. Prenosiv zapis: redak faze M7 kaže „val 2: prenosiv zapis s QR provjerom (D-49)”, a odjeljak „Val 3” navodi „prenosiv zapis i paket za zaštitu (D-49, S-01)”. D-263 Q15 stavlja prenosivi zapis u M7.Z2, a M7.10-P03 nakon M8/M9.
2. Ispis razgovora iz vanjskog alata: redak vala 2 „Izjava o vanjskom AI-ju” (D-77) naspram M7.5, koji u `docs/PROGRAM-RAZRADA.md` uključuje ispis razgovora iz vanjskog AI-ja (R-10, D-77), a u M7.Z1 je (D-263 Q15, D-266 t. 7).
3. Vremeplov: odjeljak „Val 3” navodi vremeplov (S-02); korak M7.6 spaja usporedbu i vremeplov, a D-263 Q15 u M7.Z2 navodi samo usporedbu.
4. M7.13 („moj rad u brojkama”, A-10): odjeljak „Val 3” ga navodi, a D-263 Q15 ga stavlja u M7.Z2.
5. Datum 15. 2. 2027. u D-263 Q15 stoji uz „nakon M8/M9”; zapis ne kaže je li to rok za M8/M9 ili za M7.9-P02 i M7.10-P03. D-266 t. 7 daje 15. 2. 2027. kao rok za M9.5.
6. D-263 Q15 za M7.Z2 ne daje rok ni val (1 ili 2).

##### Ovisnosti koje se ne smiju propustiti

- **Ritam za reprodukciju (D-56)** postoji samo ako se bilježi od prvog dana pisanja. Ako izmjena Ustava C-14 i C-19 i pravno mišljenje nisu gotovi prije početka pisanja završnih radova, ti radovi imat će reprodukciju samo po odsječcima, bez ritma.
- **M1** ovisi o pristupu AAI@EduHr Labu (Srce) samo u dijelu prijave na Labu (M1.1, M1.2), koji je uvjet prije stvarne uporabe. Tehnički M1 zatvara se koracima M1.3 do M1.8 (D-203 t. 4).

##### Kontrolna točka 20. 12. 2026. [ODLUČENO D-203]

Zamjenjuje kontrolnu točku 15. 12. 2026. (D-203 t. 5). Kontrolne točke 30. 11. 2026. i 15. 1. 2027. iz D-199 t. 6 ostaju.

- **Mjeri se osnovica M3 (C2):** spremanje, worker, potpisane potvrde, rekonstrukcija i oporavak, svaki dokazan uvjetom iz `docs/PROGRAM-RAZRADA.md`, ne spojenim PR-om. Osnovica ne zatvara M3. Puni B5 i ostali kriteriji M3 prihvaćaju se prije nastavnog pilota.
- **Uspoređuje se** preostali opseg vala 1 s preostalim tjednima do 22. 2. 2027., kao u D-199 t. 6.
- **Ako ne stane, ništa se ne reže samo.** Orkestrator vlasniku predaje 2 do 3 varijante, a vlasnik bira (D-203 t. 1). Isto vrijedi na kontrolnim točkama 30. 11. 2026. i 15. 1. 2027. Rezovi iz popisa niže mogući su sadržaj varijante, ne okidač. Rez 1 (prijedlozi u val 2) više ne vrijedi (D-237 nadalje, D-249; #87 c.6581656612) jer proturječi B1; varijanta koja ga ipak predlaže mora izričito navesti da mijenja B1 i tražiti novu vlasnikovu odluku.
- Puna tehnička proba nakon 22. 2. 2027. ne skraćuje se radi datuma (E3).

**Kapacitet nakon D-203, NEPROVJERENO.** D-199 t. 6 računa val 1 s M9, dijelom M8 iz D-198 i AI dijelom izjave na oko 93 do 126 nominalnih jedinica (opseg: val 1 s M9). D-203 dodaje B5 (4 do 5), izvoz M8 (3 do 5) i nastavničke izmjene po D-34 (3 do 4), dakle oko **103 do 140** (opseg: val 1 s M9, zbroj 93 do 126 i navedenih dodataka). To je drugi izračun od 103 do 141 iz odjeljka „Provjera zbroja” (opseg: val 1 i val 2 bez M9); jedan ne zamjenjuje drugi. Oba su uz neprocijenjenu shemu v2 i funkcije V11 vala 1. Stari model (10 jedinica tjedno, 14 radnih tjedana od 2. 11. 2026. do 22. 2. 2027., prekoračenje 40 %) daje oko 100. Opseg ne stane ni na donjoj granici. Ako backend dodatak već sadrži B5 (otvoreno pitanje iz „Provjera zbroja”), raspon je oko 99 do 135, što uz neprocijenjeni V11 također ne stane. Isto vrijedi ako je redak D-34 potpuno sadržan u „prijedlozima” iz M6 osnovno: tada je raspon oko 100 do 136. Stvarna brzina rada agenata još nije izmjerena (D-199 t. 6). Opseg se ne reže; vlasnik bira varijantu (D-203 t. 1), a prve varijante su u opisu PR-a koji je upisao D-203.

##### Kontrolna točka 15. 12. 2026.

**Povijesni zapis.** Zamijenjena kontrolnom točkom 20. 12. 2026. (D-203 t. 5). Okidač rezova iz D-100 izmijenjen je D-203 t. 1, a izravne izmjene po D-34 ulaze u val 1 (D-203 B1).

Uz puno radno vrijeme do tada mora biti gotov cijeli val 1 osim M11 (69 do 93 nominalne večeri s backend dodatkom, naspram oko 75 raspoloživih do tog datuma; D-99). Ako nije, val 2 se vraća na cilj sredine svibnja.

**Okidač rezova [ODLUČENO D-100].** Na kontrolnoj točki zbroji se preostala nominalna procjena vala 1 i usporedi s preostalim nominalnim večerima do 22. 2. 2027. (stvarne večeri podijeljene faktorom prekoračenja). Ako opseg ne stane, ovi rezovi stupaju na snagu redom, bez nove rasprave, dok val 1 ne stane, bez obzira na to koje su faze gotove. Ista provjera radi se i dva tjedna nakon demoa, 16. 11. 2026. Procjena uštede po rezu (nominalni raspon koji svaki rez uklanja) dodaje se uz popis niže do provjere 16. 11. 2026.; do tada se okidač računa ponovnim zbrajanjem preostalog opsega vala 1 nakon svakog primijenjenog reza. Ovo zamjenjuje raniji uvjet po kojem su rezovi stupali na snagu samo ako ni M0 do M3 nisu gotovi; taj uvjet nije pokrivao slučaj kad su M0 do M3 gotovi, a M5 do M7 nisu.

1. Prijedlozi idu u val 2; u valu 1 samo komentari.
2. Osnovna bilježnica izvora ide u val 2; DOI i ISBN ostaju.
3. Obavijesti samo kao dnevni sažetak e-poštom.
4. Sučelje na engleskom ide u val 2; Erasmus studenti pišu izvan Ductusa do vala 2.
5. M4 samo citatni stil; provjera oblika u valu 2.
6. Verifikator kao web stranica ide u val 2 (ostaje CLI); zatim objava korijena u javni repozitorij (korijen i žig ostaju). Dnevni korijen i žig (D-72) ne režu se.

Ranije dogovoreno vrijedi i dalje: izravne izmjene u valu 2, uvoz PDF-a u valu 3, doktorski radovi nakon pilota. Rezovi se upisuju u `DECISIONS.md` kao nova odluka.

Nije izabrano (10. 10. 2026.): varijanta po kojoj bi se rezovi 1 do 4 primijenili odmah i vratili u val 1 ako provjera 15. 12. pokaže da ima mjesta. Rezovi se primjenjuju samo po okidaču gore.

#### Pilot M12: prijedlozi odgovora [PRIJEDLOG, nije odluka]

Prijedlozi orkestratora po vlasnikovoj delegaciji (#87 c.6623105181, c.6623445808). Nijedan nije odluka niti ulazi u `DECISIONS.md` dok je ne donese osoba navedena uz stavku. Faze A, B i C su iz D-203 E3 (odjeljak „Rok”).

- **O01, faza B:** u B samo pisani zadaci zadani nakon izlaza A (najranije oko 22. 3.) s rokom prije 4. 6.; bez završnih i diplomskih radova (D-265 Q21). Drugi prolaz kolegija je seminarska grupa. Popis kolegija i zadataka daje FPZG. Odlučuje: FPZG.
- **O02, početak A:** A počinje kad je M11.Z1 zelen i ugovor o obradi potpisan; cilj je 22. 2. Prag: ako izlaz A nije gotov do 19. 4. 2027., vlasnik i FPZG odlučuju o B u zimskom semestru 2027./28. Stavka ide u Owner queue. Odlučuju: vlasnik i FPZG.
- **O03, obveznost:** obvezno ili dobrovoljno odlučuje FPZG (D-04). Preporuka: dobrovoljno, sa zamjenskim postupkom predaje i povlačenjem bez posljedica (D-12). Odlučuje: FPZG.
- **O04, pragovi:** pragove korisnosti i razumijevanja (`docs/PRODUCT.md` §12) postavljaju FPZG i evaluator. Upisuju se u `DECISIONS.md` prije A, kao GO uvjet. Plan ih ne izmišlja. Odlučuju: FPZG i evaluator.
- **O05, zaustavljanje pilota:** zaustaviti pilot može svaki od dvoje sam, koordinator FPZG-a ili operater. Ponovno pokretanje traži oboje i zapis incidenta. Ulogu imenuje FPZG. Odlučuje: FPZG (imenuje ulogu).
- **O06, evaluacija:** preporuka je anonimna anketa u alatu FPZG-a, gdje je FPZG voditelj obrade (C-22). Vlastita pohrana evaluacije gradi se samo ako FPZG to odbije. Odlučuju: FPZG i DPO.
- **O07, nakon pilota:** o nastavku nakon pilota odlučuju FPZG i vlasnik nakon C, na temelju završnog izvješća. Nema automatskog M13. Odlučuju: FPZG i vlasnik.
- **O08, Linear milestone „M12 Pilot”:** ništa se ne upisuje ovdje; milestone upisuje orkestrator nakon vlasnikove potvrde.

#### GO uvjeti za stvarne studente

Jedan crveni uvjet znači da val ne kreće.

| Područje      | Uvjet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Dokaz                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Tehnički      | Prvi demo iz `PRODUCT.md` §13 prolazi za radove tog vala                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Snimljen prolaz i zeleni E2E na stagingu                                |
| Tehnički      | Matrica pristupa i testovi između fakulteta zeleni                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pgTAP izvještaj                                                         |
| Tehnički      | Proba povrata iz kopije uspješna                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Zapis probe s datumom                                                   |
| Tehnički      | Produkcijska konfiguracija nema lažnog OIDC pružatelja                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Test u CI-ju                                                            |
| Tehnički      | Nema zabranjenih riječi u sučelju                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Automatska provjera u CI-ju                                             |
| Pristupačnost | axe bez kritičnih nalaza; svi tokovi tipkovnicom; editor i pregled prije predaje provjereni čitačem zaslona                                                                                                                                                                                                                                                                                                                                                                                               | Izvještaj axe i zapis ručne provjere                                    |
| Podatkovni    | DPIA i ugovor o obradi s FPZG-om potpisani; DPIA i pravno mišljenje (D-55, D-151) pokrivaju i AI pomoćnika, uključujući transkripciju i alate pružatelja (D-194 t. 4 i 5). Ugovor potpisuje pravna osoba operatera, koju vlasnik osniva odmah, usporedno s FPZG-om (D-266, Q-1 B; mijenja D-194 t. 3); ugovor o obradi potpisuje se prije tehničke probe, koja počinje kad je kod vala 1 spreman 22. 2. 2027. (D-203 E3), i ovisi o oboje; do tada pristup operatera ima samo vlasnikov račun (D-264 Q13) | Dokumenti                                                               |
| Podatkovni    | Rokovi čuvanja i dopušteni AI pružatelji potvrđeni                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `DECISIONS.md` D-30, D-35                                               |
| Podatkovni    | Obavijest o privatnosti objavljena i ugrađena u obavijest o zadatku                                                                                                                                                                                                                                                                                                                                                                                                                                       | Tekst obavijesti                                                        |
| Nastavni      | Koordinator na FPZG-u, odabrani kolegiji i mentori, odluka o obveznosti (D-04)                                                                                                                                                                                                                                                                                                                                                                                                                            | Zapis dogovora                                                          |
| Nastavni      | Pragovi za korisnost i razumijevanje iz `PRODUCT.md` §12 definirani prije tehničke probe (faza A; D-266, Q-12 A)                                                                                                                                                                                                                                                                                                                                                                                          | Zapis u `DECISIONS.md`                                                  |
| Operativni    | Kontakt za podršku, postupak incidenta, imenovana osoba na FPZG-u koja smije zaustaviti pilot                                                                                                                                                                                                                                                                                                                                                                                                             | `docs/OPERATIONS.md` (nastaje u M11)                                    |
| Operativni    | Registracija u AAI@EduHr Registru resursa odobrena                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Potvrda Srca                                                            |
| Podatkovni    | Popis podizvršitelja (hosting, baza, objekti, KMS, e-pošta, praćenje grešaka, AI pružatelji koje ustanova odobri, GitHub ako objavljuje korijene) s DPA-ima priložen ugovoru s FPZG-om (čl. 28(2) GDPR-a)                                                                                                                                                                                                                                                                                                 | Dokument                                                                |
| Tehnički      | Proba povrata baze **i** bucketa uspješna; sintetički prolaz evidencije na stagingu koji koristi iste vrste resursa kao produkcija                                                                                                                                                                                                                                                                                                                                                                        | Zapis probe                                                             |
| Sigurnosni    | Kritični nalazi vanjskog pentesta zatvoreni i potvrđeni ponovnim testom; trošak pentesta unutar stropa koji odredi vlasnik (D-266, Q-7 A)                                                                                                                                                                                                                                                                                                                                                                 | Izvještaj ponovnog testa; vlasnikova potvrda da je trošak unutar stropa |

Pilot se zaustavlja ako se dogodi kritičan neovlašten pristup, gubitak rada ili lažan status (npr. "spremljeno" a nije).

### Funkcionalne cjeline M0–M11

Prilog zahtjeva iz [izvorne revizije](https://github.com/ductura/.github/blob/265ea93a2e14a22902e17d259e31304278c30982/docs/ductus/PROGRAM-RAZRADA.md). Datirani rasporedi i povijesni opisi služe sljedivosti.

Verzija 0.2 · 1. 11. 2026. · Dopuna `docs/PROGRAM.md` prema D-191 (trag: #87 [c.6524612217](https://github.com/danielrisavi77-create/Ductus/issues/87#issuecomment-6524612217); vlasnikovo odobrenje 31. 10. 2026.: „Može, kreni bez datuma”).

Dokument daje redoslijed faza i koraka, **bez datuma**. Ciljni datumi po fazi i kontrolne točke su u D-199 t. 6 (ODLUČENO 1. 11. 2026.; novi raspored iz D-191 t. 2), kako ga mijenja D-203 (datum pilota E3, kontrolna točka 20. 12. 2026., osnovica M3 C2), i u Linear milestoneovima. Sadržaj faza i izlazni kriteriji ostaju u tablici faza u `docs/PROGRAM.md`; ovdje su razloženi na korake. U sukobu vrijede `docs/PROGRAM.md`, `docs/PRODUCT.md`, `docs/BACKEND.md` i `docs/DECISIONS.md`.

#### Kako čitati

- **Gotovo na mainu**: provjereno u kodu na `main` `5517896f` (31. 10. 2026.), ne prema planu. „Djelomično” znači da postoji dio, ali izlazni kriterij nije dokazan.
- **Koraci**: jedan korak je jedan zadatak, obično jedan ili nekoliko PR-ova. Uloga: **B** Backend, **F** Frontend, **P** Platforma, **V** vlasnik (nije posao agenta). Tiketi za korake stvoreni su 31. 10. 2026. i upisani u stupac Tiket; oznaka „novo” znači da korak još nema DAN tiket, a prijedlog tiketa ide orkestratoru. Linear ne mijenja ova razrada.
- **Ekrani**: oznake iz mape ekrana od 31. 10. 2026. (S student, N nastavnik i mentor, K koordinator i povjerenstvo, A administrator fakulteta, J javni posjetitelj, Z zajednički elementi). Ocjene mape o stanju u kodu treba provjeriti prije gradnje.
- **Oznake PLAN-TOKOVI**: A1 do E3 su koraci iz `docs/engineering/PLAN-TOKOVI-2026-10-25.md`.
- Sigurnosni nalazi navode se samo kao ID; pojedinosti su u privatnom registru.
- Faze idu redom po ovisnostima, ali koraci različitih uloga teku usporedno kad ne ovise jedan o drugom. Faza je gotova tek kad je uvjet završetka dokazan testom ili zapisom.
- **Uvjetni koraci (val 3, T3)**: korak označen „(uvjetno)” čeka odluku vlasnika, izmjenu Ustava ili PRODUCT §5, ili pravno mišljenje, i **ne gradi se** dok se uvjet ne riješi. Uvjetni korak nije dio uvjeta završetka svoje faze; uvjeti su u odjeljku „Uvjetni koraci” niže (odluka orkestratora T3, #87 c.6544288967, opcija C).
- **Oznake iz mape ekrana** u ugovorima i tiketima uvijek idu s punim nazivom ekrana, jer kolidiraju s oznakama u `docs/FEATURES.md` i `docs/DECISIONS.md` (npr. S-14, A-10, P-01). Mapa ekrana je u `docs/design/EKRANI.md`.

#### Redoslijed

M0 → M1 (čeka AAI@EduHr Lab) i M2 → M3 → M5 i M6 → M7 → M4 (čeka licencu Lekte) i M8 → M10 → M9 → M11. Izvoz DOCX-a, PDF-a i PDF/A (M8.4, M8.5, M8.14) ulazi u val 1 i ne čeka M4: radi bez paketa pravila Lekte, a provjera oblika FPZG-a uključuje se kad stigne licenca (D-203 A3, t. 2). Tehnički M1 ne čeka Lab; prijava na Labu uvjet je prije stvarne uporabe (D-203 t. 4). Shema v2 (DAN-453) ide prije funkcija V11 (D-201 t. 2), a funkcije V11 raspoređene su po fazama M5 do M9 (D-203 t. 6). M9 ne blokira nijednu drugu fazu. Koraci vezani uz vanjske račune (B0.1) i AAI Lab ne zaustavljaju ostale korake.

#### M0 Temelj

**Cilj:** repo, CI, lokalni stog i pravila gradnje na kojima stoje sve ostale faze.

**Gotovo na mainu:** CI u `.github/workflows/ci.yml` (lint, typecheck, unit, property, integration, pgTAP preko `pg_prove`, E2E i E2E prijave); sigurnosni posao (Gitleaks nad cijelom poviješću, zizmor, Semgrep, OSV); axe (`e2e/accessibility.spec.ts`); `lefthook.yml`; `compose.yaml` (Postgres 17, RustFS, Mailpit, lažni OIDC); dbmate s 52 migracije i 50 pgTAP datoteka; provjera zabranjenih izraza u CI-ju. Provjereno na `main` `34b94dab` (1. 11. 2026.): E2E na Chromiumu, Firefoxu i WebKitu dio je obveznog statusa „Local stack (compose.yaml)” na svakom PR-u (#1097, M0.3); skener zabranjenih izraza čita i tekst svojstava izvan JSX-a (#552, `247efb68`, M0.4); testovi pravila hookova prolaze na Linuxu u obveznom poslu „Lint, typecheck, test and build” (DAN-136, M0.7). **Djelomično:** kriterij „isti broj prenesenih testova kao u izvoru” vlasnik je zamijenio dokumentiranom jednakovrijednošću (#87 c.6547174354); karta je u `docs/engineering/prijenos-jezgre-M0.1-jednakovrijednost.md`, a od 273 izvorna slučaja 124 su pokrivena Ductus testom, 149 nema koda u Ductusu (dizajn je drukčiji ili funkcija još nije izgrađena), a 0 ih nedostaje kao test (provjereno na `main` `1df28c3`, 2. 11. 2026., DAN-376); ljuska još nije u konačnom vizualnom smjeru D-188.

| Korak | Naziv                                                                                                                                                                                                                                                                                                                           | Uloga | Ovisi o      | Tiket                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| M0.1  | Zapis prijenosa jezgre: broj testova u izvoru i na mainu (`docs/engineering/prijenos-jezgre-M0.1.md`)                                                                                                                                                                                                                           | P     |              | DAN-376                                                                                                          |
| M0.2  | Zaštitne mjere za dbmate (D-91) 1, 2, 4 i 6; mjere 3, 5 i 7 traže deploy i stvarna okruženja pa idu u B0.x (#87 c.6557413776); uvjet (mjere D-91 1, 2, 4 i 6 spojene) ispunjen 2. 11. 2026., dokaz u `docs/engineering/d91-mjere.md`                                                                                            | P     |              | DAN-71                                                                                                           |
| M0.3  | E2E na Firefoxu i WebKitu kao obvezna provjera                                                                                                                                                                                                                                                                                  | P     |              | DAN-114, DAN-232; gotovo: #1097 (`34b94dab`)                                                                     |
| M0.4  | Skener zabranjenih izraza i za tekst izvan JSX-a                                                                                                                                                                                                                                                                                | P     |              | DAN-133; gotovo: #552 (`247efb68`)                                                                               |
| M0.5  | Ljuska u konačnom vizualnom smjeru „papir i grafit”: tokeni, navigacija, dijalozi, mobilni raspored                                                                                                                                                                                                                             | F     | D-188 (#972) | DAN-344 (#973, #974)                                                                                             |
| M0.6  | Nalazi kontrolne ravnine i review gatea s rokom prije prvog stvarnog studenta (samo ID): F-010, F-011, F-012, F-013, F-014, F-015, F-017, F-023, F-027, F-033, F-035, F-039, F-040, F-041, F-045, F-046; F-040 i F-045 zatvaraju se za M0, ne tek prije M1, a dio F-010 koji je radnja vlasnika ide privatno (#87 c.6557413776) | P     |              | DAN-141 do DAN-144, DAN-153 do DAN-155, DAN-161, DAN-163, DAN-166, DAN-168, DAN-171 do DAN-173, DAN-177, DAN-178 |
| M0.7  | Testovi pravila hookova prolaze na Linuxu                                                                                                                                                                                                                                                                                       | P     |              | DAN-136; gotovo na `main` `34b94dab`                                                                             |

**Ekrani:** Z-01 ljuska i navigacija, Z-04 greška i 404, Z-06 učitavanje, Z-08 dijalozi, Z-13 tema.

**Uvjet završetka:** CI zelen na `main` uz obvezan E2E na Chromiumu, Firefoxu i WebKitu; zapis M0.1 postoji; mjere D-91 1, 2, 4 i 6 spojene (3, 5 i 7 su u B0.x, #87 c.6557413776); nalazi iz M0.6 zatvoreni u privatnom registru; ljuska prošla vizualnu provjeru prema D-183.

**Prihvat M0 (M0.Z, DAN-575):** dokaz po stavki na `main` `b5d2b494` i nalazi su u `docs/engineering/prihvat-M0.md`; zapis ne zatvara M0 u Linearu.

#### M1 Prijava preko AAI@EduHr

**Cilj:** studenti i nastavnici prijavljuju se isključivo preko AAI@EduHr (D-09, D-16), a račun je vezan uz izdavatelja i `hrEduPersonUniqueID`.

**Gotovo na mainu:** vlastiti OIDC klijent (`src/server/auth/`, `app/api/auth/{login,callback,logout}`) s PKCE, `state` i `nonce`; sesije u bazi; jedinstvenost (`oidc_issuer`, `hr_edu_person_unique_id`) bez spajanja po e-pošti (`db/migrations/20261003210100_identity_session.sql`, D-73), čime je D-104 pokriven na razini sheme; test da produkcijski build nema lažnog pružatelja (`tests/unit/auth/build-mode.test.ts`); pgTAP 020 do 022; ekran `/prijava`. **Nema:** prijave na stvarnom AAI@EduHr Labu.

**Prihvat tehničkog M1 (M1.Z, DAN-609):** dokaz po koraku na `main` `3160f329` i nalazi su u `docs/engineering/prihvat-M1-tehnicki.md`; M1.1 i M1.2 ostaju otvoreni kao vanjski ulaz vlasnika.

**Odluke plana M1:** atributi, istek sesije, adapter, odjava, proba na Labu, nositelj Test resursa i svježina podobnosti (P1 do P7) su D-200 u `docs/DECISIONS.md` (ODLUČENO 1. 11. 2026.).

| Korak | Naziv                                                                                              | Uloga | Ovisi o    | Tiket                                              |
| ----- | -------------------------------------------------------------------------------------------------- | ----- | ---------- | -------------------------------------------------- |
| M1.1  | Ovlast za AAI@EduHr Lab i registracija usluge                                                      | V     | FPZG, Srce | DAN-196, DAN-198                                   |
| M1.2  | Prijava na Labu: konfiguracija klijenta, mapiranje hrEdu atributa, zapis prolaza s testnim računom | B     | M1.1       | DAN-377                                            |
| M1.3  | Afilijacija djelatnika pri potvrdi nastavničke uloge                                               | B     | M1.2       | DAN-304; ostatak u novi uski tiket (D-205 t. 4)    |
| M1.4  | Odjava kod pružatelja (RP-initiated logout)                                                        | B     | M1.2       | DAN-212                                            |
| M1.5  | Izravni unit testovi `flow.ts` i `oidc.ts`                                                         | B     |            | DAN-307                                            |
| M1.6  | CSP, HSTS, Permissions-Policy i istek neaktivne sesije                                             | B     |            | DAN-296                                            |
| M1.7  | Nalazi identiteta i sesija (samo ID): F-020, F-021, F-022, F-036, F-151                            | B     |            | DAN-158, DAN-159, DAN-160, DAN-169, DAN-342 (#861) |
| M1.8  | Ekran „nema ovlasti” (401/403) i poruka o isteku sesije                                            | F     |            | DAN-378                                            |

**Ekrani:** S-01 prijava, Z-03 sesija istekla, Z-05 nema ovlasti.

Napomena (D-203 t. 4): M1.3 i M1.4 ovise o M1.2 samo za provjeru na Labu. Za tehnički M1 grade se i testiraju uz lažni pružatelj, a prolaz na Labu dodaje se kad Lab bude dostupan.

**Uvjet završetka (tehnički M1, D-203 t. 4):** spojeni koraci M1.3 do M1.8; `app_user` vezan uz `hrEduPersonUniqueID`; test da drugi izdavatelj s istim identifikatorom ne dobiva isti račun (D-104); CI test bez lažnog pružatelja u produkciji zelen; nalazi iz M1.7 zatvoreni.

**Prije stvarne uporabe:** zapisan uspješan prolaz prijave na Labu (M1.1, M1.2), uz staging M11.4 i GO uvjete. Lažni OIDC i CI nisu dokaz stvarnog AAI toka (D-203 D1).

#### M2 Model fakulteta

**Cilj:** ustanova, kolegiji, članstva, zadaci i mentorstva s ovlastima koje dokazuje pgTAP matrica, uz administraciju ustanove u sučelju.

**Gotovo na mainu:** ustanova, uloge, kolegij s pravilom AI-ja (D-52, D-175), članstvo, upis kodom, zadatak i verzije, potvrda obavijesti, raspon riječi zadatka, mentorstvo kao tablica s RLS-om (#925); pgTAP 030 do 037; HTTP rute `app/api/institution/**`; revizijski trag upisa i članstva (#819, #840); ekrani `/zadaci`, `/upis`, `/zadatak/[id]`, `/nastavnik`, `/nastavnik/zadatak/novi`; ruta za novu verziju zadatka (#870). **Nema:** oznake prilagodbe (D-50), dodjele mentorstva i njezina sučelja, administracije ustanove, komentora i povjerenstva, jezika rada odvojenog od jezika sučelja (F-06).

| Korak | Naziv                                                                                                                                                                                                         | Uloga | Ovisi o | Tiket                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------- | ------------------------------------------------------ |
| M2.1  | Rad nastaje tek na „Započni rad”, uz korak na poslužitelju                                                                                                                                                    | F, B  |         | DAN-330 (#830), DAN-331 (#831)                         |
| M2.2  | HTTP rute za preostale institucijske RPC-ove                                                                                                                                                                  | B     |         | DAN-292; ostatak u novi uski tiket (D-205 t. 4)        |
| M2.3  | Studentska projekcija kolegija, zadataka i radova; ekran Moji radovi (B1, B2)                                                                                                                                 | B, F  |         | DAN-309, #941                                          |
| M2.4  | Zadatak u postojećem kolegiju, uređivanje s pregledom posljedica i čarobnjak zadatka (B3, B8)                                                                                                                 | F     | M2.2    | DAN-310                                                |
| M2.5  | Popis studenata kolegija i zadatka s imenima                                                                                                                                                                  | B, F  |         | #948 (DAN-344)                                         |
| M2.6  | Mentorstva: put evidencije, čitači i RPC: studentov zahtjev i nastavnikovo odobrenje, uz revizijski trag i provjeru ustanove; mentor samo uz potvrđenu nastavničku ulogu; administrator ne dodjeljuje (D-204) | B     |         | DAN-349 (#947); ostatak u novi uski tiket (D-205 t. 4) |
| M2.7  | Nastavni tim kolegija i seminarske grupe                                                                                                                                                                      | B     |         | DAN-351                                                |
| M2.8  | Komentor i povjerenstvo s vremenski ograničenim pristupom (model, N-08, N-09); komentor po radnjama, bez zadanog skupa ovlasti, a skup se određuje uz U-1 prije M6.12 (D-205 t. 3)                            | B     | M2.6    | DAN-379                                                |
| M2.9  | Oznaka odobrene prilagodbe (D-50): nastavnik vidi oznaku, ne razlog                                                                                                                                           | B, F  |         | DAN-380                                                |
| M2.10 | Jezik rada odvojen od jezika sučelja (F-06)                                                                                                                                                                   | B     |         | DAN-386                                                |
| M2.11 | Administracija ustanove: pregled, korisnici i uloge, kolegiji i akademske godine (C1 do C3)                                                                                                                   | B, F  | M1.3    | DAN-313                                                |
| M2.12 | Pravila fakulteta i njihove verzije (D-117, D-175)                                                                                                                                                            | B, F  | M2.11   | DAN-315                                                |
| M2.13 | Potvrda obavijesti veže otisak teksta obavijesti                                                                                                                                                              | B     |         | DAN-306                                                |
| M2.14 | Mentorovi radni zapisi navedeni u obavijesti studentu (D-130)                                                                                                                                                 | F     |         | DAN-235 (#553)                                         |
| M2.15 | Nalazi granice baze (samo ID): F-018, F-019; RLS uz `current_actor()` kao initplan                                                                                                                            | B     |         | DAN-156, DAN-157, DAN-51                               |
| M2.16 | Ključ ustanove kroz `assignment_version` (preuzima FK dio DAN-301 N-1; D-199)                                                                                                                                 | B     |         | DAN-442                                                |
| M2.17 | Konfiguracija po ustanovi (D-199)                                                                                                                                                                             | B     |         | DAN-443                                                |

ISVU adapter (F-07) nije korak ove tablice: ide u zaseban tiket s rokom „prije stvarne uporabe” (D-205 t. 2).

**Ekrani:** S-02 studentska početna, S-03 moji kolegiji, S-04 upis kodom, S-05 obavijest (dio o zadatku), N-01 moji kolegiji, N-02 novi kolegij i zadatak, N-03 čarobnjak zadatka, N-04 popis studenata, N-16 radovi uz mentora (podaci), A-01 pregled ustanove, A-02 korisnici i uloge, A-03 kolegiji i akademske godine, A-04 pravila fakulteta.

**Uvjet završetka:** pgTAP matrica zelena za studenta, nastavnika, mentora, komentora, člana povjerenstva, administratora i osobu druge ustanove; E2E: administrator potvrdi nastavnika, nastavnik napravi kolegij i zadatak, student se upiše i potvrdi obavijest; svaki RPC koji mijenja stanje ima HTTP rutu ili zapisan razlog zašto je nema; administracija ustanove radi u sučelju. **Rokovi (D-205 t. 1):** ova jezgra do 30. 11. 2026., ostatak koraka M2 do 20. 12. 2026.

#### M3 Evidencija

**Cilj:** svaka promjena dokumenta postaje cjelovit, potpisan i provjerljiv zapis, i kad student radi bez mreže.

**Gotovo na mainu:** JCS i hash lanac, odsječak v2 i v3, potvrda (`src/domain/forensics/`); izvori unosa uključujući lijepljenje (D-43) i vrste dokaza (D-44); rute `app/api/evidence/{commit,open,replay}`; jedan RPC za commit i `reserve`, odbijanje nepoznatih polja i granice veličine (B-8); provjera hasha uklonjenog raspona (B-12, `src/adapters/evidence/edit-steps-v1-rules.ts`); osam stanja sinkronizacije sa „spremljeno na poslužitelju” tek uz potpisanu potvrdu; journal vezan uz korisnika i odjava po D-118; format vremena po promjeni v1 i njegov verifikator (#942); pgTAP 040 do 049 i 088. **Djelomično:** potpis i rekonstrukcija u workeru izašli su iz demoa (D-98) i vraćeni su u opseg (D-191 t. 4); nema mjerenja rekonstrukcije velikog rada (B0.2) ni spikea D-54.

**Odluke za plan (D-207 do D-216, #87 c.6567392018):** worker se gradi u `src/runtime/worker/` (`docs/ARCHITECTURE.md`), a spike B0.2 u postojećem `spikes/b0.2-reconstruction`; putanja `src/worker/` iz paketa ne usvaja se (D-214). Ostatak DAN-84 i DAN-453 ide u nove uske tikete (D-210).

| Korak | Naziv                                                                                                                                                                 | Uloga | Ovisi o            | Tiket                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| M3.1  | Zatvoriti preostali opseg B-8                                                                                                                                         | B     |                    | DAN-83 (#970)                                                                                                      |
| M3.2  | Worker potpisuje potvrdu i oporavlja `pending_signature` (B-9); ostatak u novom uskom tiketu (D-210)                                                                  | B     |                    | DAN-84                                                                                                             |
| M3.3  | Kontrolne točke rekonstrukcije u B-12 i čitanje snimki dokumenta                                                                                                      | B     | M3.2               | DAN-293                                                                                                            |
| M3.4  | Spike B0.2: rekonstrukcija 15.000 i 80.000 riječi na stvarnom stroju; puni M3, ne osnovica (D-208)                                                                    | P     | stroj, B0.1 (D-08) | DAN-388                                                                                                            |
| M3.5  | Spike programskog unosa (D-54); M3.5-P01 je `Risk: critical`, a ugovor zabranjuje bilježenje tipki i trajanja (pravilo 4, D-216)                                      | B     |                    | DAN-390                                                                                                            |
| M3.6  | Ostaci evidencije i značenje odgovora na ponovljeni `ingest`; ponovno izdavanje nakon opoziva po varijanti A zapisuje se prije M3.6-P02 (D-212)                       | B     |                    | DAN-301, DAN-46                                                                                                    |
| M3.7  | Nalazi evidencije, lokalnog zapisa i rekonstrukcije (samo ID): F-001, F-003 do F-008, F-028, F-029, F-030, F-034, F-037, F-038, F-043, F-048, F-049, F-154            | B, F  |                    | DAN-140, DAN-145, DAN-146, DAN-147 do DAN-152, DAN-164, DAN-165, DAN-167, DAN-170, DAN-175, DAN-180, DAN-181, #913 |
| M3.8  | Produkcijski potpisnik preko KMS-a; puni M3, ne osnovica (D-208)                                                                                                      | B     | B0.1 (M11.1)       | DAN-295                                                                                                            |
| M3.9  | Specifikacija i izvedba dnevnog korijena i žiga s CLI verifikatorom (B5, D-72, D-93); D-72 je ODLUČEN (D-209), a M3.9-P05 i P07 grade se tek nakon tog zapisa         | B     | M3.2               | DAN-55; izvedba DAN-391                                                                                            |
| M3.10 | Fuzz parsera B-8 i B-12 (zasad fast-check, Jazzer tek nakon provjere licence i ovisnosti, D-213) te proba izgubljenog odgovora nakon prihvata bez Toxiproxyja (D-211) | P, B  |                    | DAN-320                                                                                                            |
| M3.11 | Oznake stanja spremanja po rječniku i izlaz iz blokirane odjave; Z-02 slijedi D-118, bez blokirane odjave (D-216)                                                     | F     |                    | DAN-99, DAN-103                                                                                                    |
| M3.12 | Kratki sintetički spike šifriranja i roka (D-122); datum unutar faze do 20. 12. 2026. (D-207)                                                                         | B     |                    | novo                                                                                                               |

**Ekrani:** S-10 editor (stanja spremanja), Z-02 odjava i dijalog, Z-11 rad bez mreže, druga kartica i oporavak.

**Uvjet završetka:** izlazni kriterij M3 iz `docs/PROGRAM.md` (property testovi, idempotentno ponovno slanje, oporavak prekida između Storagea, RPC-a i potpisa, izmjereno CPU vrijeme rekonstrukcije doktorskog rada u zapisu B0.2); potvrdu potpisuje worker; B5 prolazi known-answer vektor i negativne slučajeve iz `docs/BACKEND.md` §8; nalazi iz M3.7 zatvoreni; pravilo 10 (zapis nastao bez mreže ostaje tako označen i nakon sinkronizacije) ima test (D-216).

**Osnovica 20. 12. 2026. (D-203 C2, D-208):** spremanje, worker koji potpisuje (M3.2) s testnim potpisnikom, potpisane potvrde, rekonstrukcija (M3.3) i oporavak. Osnovica se mjeri na kontrolnoj točki 20. 12. i ne zatvara M3. Puni B5 (M3.9) i ostali dijelovi uvjeta završetka prihvaćaju se prije nastavnog pilota; B5 se ne prebacuje iza pilota bez posebne odluke. Stvarni KMS (M3.8) i B0.2 na stroju (M3.4) dio su punog M3 i ovise o B0.1 (D-08).

**Poznata granica (D-215):** inventar v1 pretpostavlja da izvan razvojnih i demo računala nema trajnih izvora potvrda; Daniel tu pretpostavku može ispraviti.

#### M4 Paket pravila Lekte

**Cilj:** pravila akademskog pisanja FPZG-a dolaze iz verzioniranog paketa Lekte, a Ductus ih samo čita i provjerava (D-117, pravilo 12).

**Gotovo na mainu:** FPZG citatni stil kopiran iz Lekte kao čista funkcija (`src/domain/citation/{style,format}.ts`, K-2). **Nema:** paketa, profila ni provjere oblika.

| Korak    | Naziv                                                                                                                                                                                                                                                            | Uloga | Ovisi o    | Tiket                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- | -------------------- |
| M4.1     | Licenca i pravo redistribucije Lekte                                                                                                                                                                                                                             | V     |            | Owner queue          |
| M4.2     | U Lekti: generiran paket pravila (FPZG profili, oblik, citatni stilovi, naslovna stranica) s verzijom i testom zanošenja; izvodi ga Lekta sesija po Lektinim pravilima, uz Lekta tiket povezan s DAN-392, a Ductus orkestrator ne dodjeljuje Lekta pisce (D-224) | P     | M4.1       | DAN-392 (repo Lekta) |
| M4.3     | Ductus učitava paket s verzijom; kopija iz K-2 prelazi na paket                                                                                                                                                                                                  | B     | M4.2       | DAN-393              |
| M4.3-P06 | Uvoz prvog paketa; spaja se samo na vlasnikov „Spoji n” (D-217)                                                                                                                                                                                                  | B     | M4.2, M4.3 | novo                 |
| M4.4     | Provjera oblika nad dokumentom i „S-11 — Panel Upute i provjera oblika”                                                                                                                                                                                          | F     | M4.3, M5.3 | DAN-394              |

**Ovisnosti i podjela (plan M4 iz paketa „M4 v1.0”, nije u repou; uz D-217 do D-224):**

- Pin paketa na `assignment_version` ide iza M2.12-P01, M2.13-P01 i M2.4-P02.
- Citatni stil ima jedan izvor, pin paketa; M2.12-P02 ne uvodi vlastiti.
- Puna DOCX provjera dijeli se na P05a (ugovor, sada) i P05b (stvarna provjera, nakon M8.4); samo formalne provjere, informativne, nikad ne blokiraju predaju (D-222).
- M4.3-P06 je uvoz prvog paketa; M4.0a (docs PR s ovim odlukama) i svaki uvoz paketa idu na „Spoji n” (D-217).
- M4 ulazi u automatski red sa 25 koraka.

**Ekrani:** S-11 — Panel Upute i provjera oblika. Napomena o koliziji naziva: u `docs/FEATURES.md` (r. 19) i u M5.12 oznaka S-11 znači uvodni vodič od dvije minute; puni naziv razlikuje ova dva ekrana.

**Uvjet završetka:** izlazni kriterij M4 iz `docs/PROGRAM.md` (profili učitani s verzijom, test zanošenja u Lekti, provjera oblika javlja odstupanja na izmišljenim testnim radovima).

#### M5 Akademski editor

**Cilj:** student u Ductusu napiše cijeli akademski rad u obliku fakulteta, sa svakim novim elementom zapisanim u evidenciji.

**Gotovo na mainu:** shema s odlomkom, naslovom, stavkom popisa i blok-citatom (`src/domain/document/schema.ts`); popis naslova; opseg u traci stanja; identitet blokova; format odsječka v3 s izvorom citata (#904). **U tijeku:** citati i literatura (#866, samo obrazac; ne zatvara M5.1). Traka alata (#976), ljuska editora (#980) i dopuna elemenata iz prototipa (#344) zatvoreni su bez spajanja; M5.2 polazi od maina i odobrene reference. **Nema:** fusnota, tablica, slika, sadržaja, naslovne stranice, citata i bibliografije kao čvorova, provjere DOI-ja, opsega po poglavlju, bilježnice izvora, traži i zamijeni, fokusa.

**V11 (D-201, D-203 t. 6):** prvo shema v2 (DAN-453, `Risk: critical`, ugovor i plan napada prije koda), s rezerviranim mjestom u formatu zapisa za prijedloge i izravne izmjene po D-34. U val 1 ulaze funkcije V11 koje pripadaju osnovnom editoru, komentarima, D-34 i izvozu; ostale idu u val 2 i 3 prema fazama M5 do M9. Koraci za funkcije V11 dodaju se s tiketima koje otvara orkestrator.

| Korak  | Naziv                                                                                                                              | Uloga | Ovisi o                                                                                      | Tiket                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------- | ------------------------------ |
| M5.1   | Citat u tekstu i bibliografija kao čvorovi dokumenta (D-191 t. 4)                                                                  | F     |                                                                                              | DAN-343 (#866)                 |
| M5.2   | Traka alata, popis naslova i napredak naspram opsega; ljuska editora                                                               | F     | M0.5                                                                                         | DAN-211 (#976), DAN-214 (#980) |
| M5.3   | Numerirani naslovi i sadržaj                                                                                                       | F     |                                                                                              | DAN-395                        |
| M5.4   | Naslovna stranica: opća naslovnica bez paketa Lekte u valu 1, predložak iz paketa poslije; izjava tek u M7.5 (D-228)               | F     | M4.3 samo za predložak iz paketa                                                             | DAN-403                        |
| M5.5   | Fusnote                                                                                                                            | F     |                                                                                              | DAN-404                        |
| M5.6   | Tablice, slike s opisima, popisi tablica i slika, pozivi na prikaze; sve vrste slika uz sigurnu obradu i privatan spremnik (D-231) | F, B  |                                                                                              | DAN-405                        |
| M5.7   | DOI i ISBN u bibliografskom zapisu (S-08); provjera „pronađeno / nije pronađeno” za DOI i URL (D-48)                               | B, F  | M5.1                                                                                         | DAN-406                        |
| M5.8   | Opseg po poglavlju (D-60)                                                                                                          | F     | M5.3                                                                                         | DAN-407                        |
| M5.9   | Bilježnica izvora (D-59), kasnije uvoz iz Zotera                                                                                   | F, B  | M5.1                                                                                         | DAN-408                        |
| M5.10  | Hrvatski navodnici, traži i zamijeni, način fokusa                                                                                 | F     |                                                                                              | DAN-409                        |
| M5.11  | Pravopis prema jeziku rada bez slanja teksta van (S-07)                                                                            | F     | M2.10                                                                                        | DAN-410                        |
| M5.12  | Uvodni vodič od dvije minute (ekran S-45; S-11 iz `docs/FEATURES.md`)                                                              | F     |                                                                                              | DAN-418                        |
| M5.13  | Nalaz identiteta blokova u editoru (samo ID): F-044                                                                                | F     |                                                                                              | DAN-176                        |
| M5.14a | Panel Nacrt (S-14), ljuska kartice i prikaz Obrnuti nacrt, samo izvedeno iz dokumenta (`docs/design/PANEL-NACRT-SPEC.md`)          | F     | M5.2, M5.3, M0.5, M5.13; naziv kartice „Struktura” i prikaza „Prve rečenice” (D-234)         | novo                           |
| M5.14b | Panel Nacrt: pohrana plana (pitanje rada, svrhe poglavlja, pojmovnik) kao zapis uz rad; tablica s RLS-om, RPC, pgTAP               | B     | M5.14a, M3.11; pohrana, vidljivost i dorada prema D-234                                      | novo                           |
| M5.14c | Panel Nacrt: prikazi Nit i Pojmovnik nad pohranom                                                                                  | F     | M5.14b, M2.10                                                                                | novo                           |
| M5.15  | Planer rada iz roka i opsega po poglavlju (S-06)                                                                                   | F     | M5.8, spajanje #1030 (izuzetak u PRODUCT §5 pravilu 4: napredak po poglavlju i dani do roka) | novo                           |

Svaki novi čvor sheme traži pravilo u formatu koraka uređivanja i test reprodukcije prije spajanja (B-12).

Koraci M5.14a do M5.14c: odluka vlasnika 31. 10. 2026. da panel Nacrt ulazi u program (#87 c.6543799262, t. 5). Odgovori na pitanja 1, 2, 3, 4, 6 i 9 iz `docs/design/PANEL-NACRT-SPEC.md` §9 su D-234 (2. 11. 2026.): plan na poslužitelju izvan evidencije, mentor ga u valu 1 ne vidi, kartica „Struktura” i prikaz „Prve rečenice”, bez pragova, plan uređiv u doradi, podjela M5.14a/b/c prihvaćena. Pitanja 5, 7 i 8 ostaju PRIJEDLOG specifikacije; nisu bila uvjet za početak koraka.

**Ovisnosti i podjela (plan M5 iz paketa M5, nije u repou; uz D-225 do D-236):**

- Shema v2 ima vlastiti ugovor i plan napada prije koda (M5.0-S1); prihvaća se s prvim novim čvorom, navodom (M5.1-P04). Novi radovi počinju na v2, v1 ostaje v1 (D-225).
- Navod, izvori i bibliografija slijede D-226; trajni popis izvora i bilježnica izvora (M5.9) dijele isti model.
- Val 1 i val 2 prema D-227: dva prihvata, M5 osnovno (20. 1. 2027.) i puni uvjet faze.
- M5.4 se dijeli (D-228): opća naslovnica u valu 1, predložak iz paketa nakon M4.3; M8.4 ne čeka licencu Lekte.
- M5.3 daje jedinu projekciju poglavlja po stabilnom id-u bloka; M5.8, M5.14 i M4.4 je koriste, bez druge projekcije. M4.3-P03 ide iza spajanja #866.
- Numerirani popis (V11, D-201 t. 2) dobiva vlastiti korak M5.V1 kao čvor sheme v2.
- Slike (D-231): ugovor i plan napada M5.6, zatim pohrana s RLS-om i spremnik; spremnik u lokalnom stogu i stagingu ide na „Spoji n”.
- UI koraci M5 čekaju odobrene referentne slike (D-235); domena i backend ne čekaju.

**Ekrani:** S-10 editor, S-13 Literatura i bilježnica izvora, S-14 panel Nacrt, u sučelju kartica „Struktura” (`docs/design/PANEL-NACRT-SPEC.md`, D-234), S-45 prvi ulazak i vodič (S-11 iz `docs/FEATURES.md`).

**Uvjet završetka:** izlazni kriterij M5 iz `docs/PROGRAM.md` (izmišljeni testni rad od 15.000 riječi sa svim elementima uređuje se bez gubitka; citati i bibliografija usklađeni; napredak studenta iz verzija, D-63); rekonstrukcija tog rada podudarna. Prihvat M5 osnovno (val 1) nije završetak faze (D-227).

#### M6 Suradnja

**Cilj:** mentor i nastavnik zadatka prate rad uživo, komentiraju i predlažu izmjene, a svaka izmjena pripisana je autoru (pravila 7 i 8).

**Gotovo na mainu:** komentari uz odlomak (B-10, `app/api/comments/[action]`); prikaz uživo kroz zaseban kanal zadnjeg stanja (`docs/BACKEND.md` §4.12, `app/api/live/[documentId]`, `/nastavnik/rad/[id]`); „Kako vidi nastavnik” (#815); čitanje reprodukcije na poslužitelju (#927, pgTAP 089). Prikaz uživo od D-142 radi prema §4.12; „polling, D-74” u `docs/PROGRAM.md` ispravljen je u M6.0a, D-74 vrijedi za obavijesti. **Nema:** prijedloga izmjena, izravnih izmjena nastavnika, sučelja reprodukcije, zahtjeva za doradu, obavijesti.

| Korak | Naziv                                                                                                                                                                                                              | Uloga | Ovisi o               | Tiket                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | --------------------- | ----------------------------------------------------------------- |
| M6.1  | Prikaz uživo: predani rad prikazan kao predan; mentorski prikaz s komentarom                                                                                                                                       | F, B  |                       | DAN-332 (#911), DAN-215                                           |
| M6.2  | Reprodukcija za mentora, odnosno nastavnika zadatka, i za studenta (D-143, D-154); val 1 prikazuje samo redoslijed promjena, vremenski podaci tek uz DPIA (D-239)                                                  | F     | M3.1                  | DAN-344 (#932)                                                    |
| M6.3  | Prijedlozi izmjena s prihvaćanjem kao zasebnom promjenom s izvorom                                                                                                                                                 | B, F  | M5.1                  | DAN-419                                                           |
| M6.4  | Izravne izmjene nastavnika s pripisivanjem i postavkom vidljivom na radu (D-21, D-34); val 1, cijeli tok po D-34 (D-203 B1)                                                                                        | B, F  | M6.3                  | DAN-420                                                           |
| M6.5  | Zahtjev za doradu i odgovor studenta (D-45), uključujući „promijenjeno nakon prihvaćanja”                                                                                                                          | B, F  |                       | DAN-314, DAN-266                                                  |
| M6.6  | Obavijesti u aplikaciji, podsjetnici o roku (N-01, N-02); e-pošta tek nakon izbora pružatelja i DPA, bez tvrdnje „poslano točno jednom” (D-241)                                                                    | B, F  |                       | DAN-305 (#950) za spojeni dio, novi uski tiket za ostatak (D-246) |
| M6.7  | Odgođeno objavljivanje komentara (D-51), banka komentara (N-03), promjene od zadnjeg pregleda (N-05)                                                                                                               | F, B  |                       | DAN-421, novi uski tiket (D-246)                                  |
| M6.8  | Mentorov pregled rada i komentari na mobitelu                                                                                                                                                                      | F     | M6.1                  | DAN-422                                                           |
| M6.9  | Konzultacije vezane uz verziju rada (D-47); dio „Bilješka mentora” je uvjetan (U-2, D-135)                                                                                                                         | B, F  | M2.6                  | DAN-423                                                           |
| M6.10 | Zbirni pregled kolegija bez imena (N-11, ekran N-17); val 2, prag od najmanje 5 studenata, zaštita komplementa, zatvoren popis mjera, bez ljestvice (D-242)                                                        | B, F  |                       | DAN-425                                                           |
| M6.11 | Ključni rokovi mentorskog rada (N-07 iz `docs/FEATURES.md`)                                                                                                                                                        | B, F  | M2.6, M6.6            | novo                                                              |
| M6.12 | (uvjetno) Sučelje komentora i povjerenstva s vremenski ograničenim pristupom (N-08, N-09, ekran P-01 povjerenstvo); model je M2.8; povjerenstvo ne vidi reprodukciju dok se ne izmijene Ustav v1.4 i D-154 (D-238) | F, B  | M2.8, M6.1, uvjet U-1 | novo (D-246)                                                      |
| M6.13 | (uvjetno) Etape mentorskog rada s odobravanjem (N-15 etape) — u M6 se ne gradi (D-249)                                                                                                                             | B, F  | M6.9, uvjet U-2       | novo                                                              |
| M6.14 | (uvjetno) Rubrika i nacrt izvješća kao mentorovi radni zapisi (N-15 rubrika i izvješće, D-130, D-135) — u M6 se ne gradi (D-249)                                                                                   | B, F  | M6.13, uvjet U-2      | novo                                                              |
| M6.15 | (uvjetno) Ocjena vidljiva studentu tek nakon objave (N-15 ocjena, D-135) — u M6 se ne gradi (D-249)                                                                                                                | B, F  | M6.14, uvjet U-2      | novo                                                              |

**Odluke M6 (D-237 do D-250, #87 c.6581656612):**

- Usporedba poslanih verzija u oba profila, bez oznake i ocjene (D-237). Ponovni pregled nakon dorade je novi ciklus odgovora na novoj verziji zahtjeva, bez automatske presude (D-243).
- Zadano su prijedlozi; izravne izmjene samo uz vidljivu i opozivu postavku koju uključi student (D-244; M6.3, M6.4).
- Glasovni komentar (N-04) u val 2 sa sintetičkim podacima, za stvarne studente isključen do DPIA (D-240).
- Referentne slike za nove ekrane izrađuje M6.UX-R; UI čeka odobrenje slika, backend ne čeka (D-245). Linear: novi uski tiketi za reproduktor, ostatak obavijesti, M6.7 i M6.11 do M6.15; DAN-344 i DAN-305 se ne otvaraju ponovno (D-246).
- Samo hrvatski, engleski s M11 (D-247). Razina pristupačnosti koju repo već traži; WCAG 2.2 AA je cilj za nove ekrane (D-248).
- M6.13 do M6.15 (etape, rubrika, ocjena) i uvjet U-2 u M6 se ne grade (D-249); rez 1 iz `docs/PROGRAM.md` više ne vrijedi.
- M6.0a (ovaj docs PR) i M6.UX-R idu na „Spoji n”; M6 ulazi u automatski red.

**Ekrani:** S-12 komentari studenta, S-17 kako vidi nastavnik, S-34 reprodukcija vlastitog rada, S-40 komentari na mobitelu, S-41 i Z-07 obavijesti, N-06 rad uživo, N-07 pregled rada, N-08 komentari, prijedlozi i dorada, N-09 reprodukcija, N-12 konzultacije, N-17 zbirni pregled.

**Uvjet završetka:** izlazni kriterij M6 iz `docs/PROGRAM.md`; uz to pgTAP i E2E dokazuju da reprodukciju vide samo mentor, odnosno nastavnik zadatka, i student, a nitko drugi (pravilo 7); obavijest nastavniku ne stiže češće od P-03. Koraci M6.12 do M6.15 (uvjetno) nisu dio uvjeta završetka; M6.13 do M6.15 se u M6 ne grade (D-249).

#### M7 Predaja i sažetak

**Cilj:** student predaje rad koji se točno rekonstruira iz zapisa i dobiva potpisanu potvrdu, a student i nastavnik vide isti sažetak procesa (pravila 5 i 11).

**Gotovo na mainu** (za M7 ponovno provjereno na `main` `cb4fbde1`, 10. 11. 2026., zadatak M7.0a)**:** zahtjev za predaju, zapis predaje, potvrda v2 i zatvaranje paketa (pgTAP 060 do 067, 070, 071, 086, 087); predani rad samo za čitanje (#818); rekonstrukcija i odluka o predaji; sažetak procesa iz jedne funkcije (`app/api/process-summary`); obavijest S3 i njezina vrata; tri koraka predaje na `/rad/[assignmentId]/predaja`; brz put nastavnika i popis predaja zadatka (#878, #909). **Djelomično:** usporedba s ranijim nacrtom. **Nema:** produljenja roka (nema tablice povijesti produljenja), izjave po FPZG čl. 9 i 15, rekonstrukcije u workeru. **Preduvjeti za M7.1 spojeni na main:** red poslova workera (#1829, DAN-517), asinkrono spremanje odsječka uz potvrdu na čekanju (#1758, DAN-518) i kontrolne točke rekonstrukcije vezane uz lanac (#1824, #1827, DAN-293); status tiketa vodi Linear.

| Korak | Naziv                                                                                                                                                                                                                | Uloga | Ovisi o                                                      | Tiket            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------ | ---------------- |
| M7.1  | Rekonstrukcija u workeru (D-191 t. 4)                                                                                                                                                                                | B     | M3.2, M3.3, DAN-517 i DAN-518 (Q-4)                          | DAN-381          |
| M7.2  | Nastavnik vidi tko je predao, reviziju i „poslije roka”; detalj zadatka i pregled predane verzije (B6)                                                                                                               | B, F  |                                                              | DAN-290, DAN-311 |
| M7.3  | Produljenje roka po studentu (B9)                                                                                                                                                                                    | B, F  |                                                              | DAN-312          |
| M7.4  | Rok testiran preko promjene sata                                                                                                                                                                                     | B     | M7.3                                                         | DAN-382          |
| M7.5  | Izjava po FPZG čl. 9 i 15 (D-40), izjava o ljudskoj pomoći (R-09), ispis razgovora iz vanjskog AI-ja uz izjavu (R-10, D-77)                                                                                          | F, B  |                                                              | DAN-383          |
| M7.6  | Usporedba verzija i vremeplov za studenta (C5, S-02 iz `docs/FEATURES.md`)                                                                                                                                           | B, F  | M3.3                                                         | DAN-293          |
| M7.7  | Karta podrijetla bez zbroja (D-57), otvorena mjesta (D-61), pravila zadatka s kontrolnim popisom bez oznaka prolaza (D-62)                                                                                           | F     |                                                              | DAN-384          |
| M7.8  | Napomena, dopuna i osporavanje opisa događaja (R-08)                                                                                                                                                                 | B, F  |                                                              | DAN-385          |
| M7.9  | Test jednakosti prikaza u sučelju, API-ju i izvozu kao uvjet builda (R-07)                                                                                                                                           | P     |                                                              | DAN-387          |
| M7.10 | Prenosiv zapis s QR provjerom (D-49), javna provjera potvrde i otvoreni verifikator zapisa (A-07 iz `docs/FEATURES.md`)                                                                                              | B, F  | M3.9                                                         | DAN-389          |
| M7.11 | (uvjetno) Priprema za razgovor: deterministički popis mjesta uz studentove izjave, „razgovor održan” bez polja za ocjenu (D-53; ekran N-14 priprema za razgovor i obranu)                                            | F, B  | M6.5, M7.5, M7.7, uvjet U-3                                  | novo             |
| M7.12 | (uvjetno) Priprema za obranu, samo za studenta (A-04 iz `docs/FEATURES.md`)                                                                                                                                          | F     | M7.11, uvjet U-3                                             | novo             |
| M7.13 | „Moj rad u brojkama” za studenta, bez ritma i usporedbe (A-10 iz `docs/FEATURES.md`, u mapi ekrana S-47; ne miješati s ekranom A-10 slučajevi i paket dokaza). Brojke samo iz verzija i samo za studenta, prema D-63 | F     | M7.1, M5.8, spajanje #1030 (izuzetak u PRODUCT §5 pravilu 4) | novo             |

**Odluke M7 (D-263, #87 c.6622685877; D-266 t. 7, #87 c.6639423372):**

- Valovi M7.Z1 i M7.Z2, rokovi i otvoreni neskladi s valovima zapisani su u `docs/PROGRAM.md`, odjeljak „Valovi M7” (D-263 Q15).
- Usporedba: M6-O1 je odlučen; usporedba vrijedi u oba profila, samo između poslanih verzija, bez oznake i ocjene (D-237, #87 c.6581656612). **Otvoreno:** zadatak DAN-598 navodi da M7.6-P01 proširuje M6.7-P03 umjesto drugog čitača usporedbe, ali oznake M7.6-P01 i M6.7-P03 i to pravilo nemaju zapis u `docs/DECISIONS.md` ni na #87; redak M6.7 u ovoj razradi usporedbu ne navodi.
- Rok: zahtjev za predaju zamrzava efektivni rok, a produljenje je zasebna dopuna; povijest produljenja dobiva novu tablicu (M7.3-P01). Model efektivnog roka još nije zapisan u `docs/BACKEND.md`; taj zapis otvara D-263 (D-263 Q07). M7.4 ovisi o M7.3, a oba su u M7.Z1 (D-263 Q15). **Otvoreno:** zadatak DAN-598 traži upis ovisnosti M7.4, a izvor koji bi mijenjao ovisnost o M7.3 nije pronađen u `docs/DECISIONS.md` ni na #87, pa ovisnost ostaje kako je zapisana.
- Runde: izričito otvorene runde, prethodna predaja nepromjenjiva; expand migracija zamjenjuje `UNIQUE (assignment_id, institution_id, principal_id)` na `submission_request` (M7.1-P07) i nije potrebna prije M7.1-P01 do P06 (D-263 Q08, provodi D-28).
- Worker: odjava ne zaustavlja prihvaćen posao predaje, potvrđeni opoziv blokira novu finalizaciju, worker radi s uskim opsegom posla bez korisničkog kolačića (D-263 Q03). Nepotpisani odsječak: ostaje sadašnji blok s ponovnim pokušajem, praznina se prikazuje kao praznina (D-263 Q26).
- Izjava: do 5. 2. 2027. M7.5 ima AI odjeljak nad zatvorenim formatom priloga, a M9.5 daje proizvođača priloga do 15. 2. 2027. (D-266 t. 7). Prilažu se točne verzije cijelih odabranih razgovora, prikazane prije potvrde; popis vanjskih formata zatvara se prije koda (M7.5-P02, D-263 Q22). Prijenos teksta koji je kasnije obrisan i dalje čini razgovor obveznim (D-268 O3).
- Prenosiv zapis: zaseban verzioniran potpisani manifest s jednim nositeljem zajedno s M8.6 (DAN-341), a `evidence-receipt-v2` ostaje (D-263 Q23). QR otvara lokalnu provjeru, nema javnog krajnjeg mjesta s podacima (D-263 Q24). **Otvoreno:** naziv koraka M7.10 („javna provjera potvrde”) i ekran J-03 naspram D-263 Q24.
- Referentne slike M7.UX-R prije UI PR-ova; backend ne čeka (D-263 Q16), odobrenje po ekranu (Q-8, #87 c.6639423372). M7 samo na hrvatskom, engleski s M11 (D-263 Q28).
- Uvjetni koraci: M7.6-P03, M7.11 i M7.12 ne grade se bez potvrde FPZG-a i C-42, pravnog mišljenja (D-55, C-19), odnosno U-3; potvrđuje stanje kanona (D-129, D-131) (D-263 Q27). **Otvoreno:** zapis ne razlaže koji uvjet ide uz koji korak; ovdje su M7.11 i M7.12 vezani uz U-3, a M7.6-P03 nema redak ni u tablici koraka ni među uvjetnim koracima.
- **Otvoreno:** DAN-293 stoji i uz M3.3 i uz M7.6; spojeni PR-ovi #1824 i #1827 (DAN-293) su kontrolne točke rekonstrukcije, odnosno M3.3.

**Ekrani:** S-05 obavijest (S3), S-15 panel Rad, S-30 pregled prije predaje, S-31 izjava, S-32 potvrda, S-33 sažetak procesa, S-43 napomene i osporavanje, N-05 brz put, N-10 sažetak i karta podrijetla, N-11 usporedba verzija, N-13 produljenje roka, J-03 provjera potvrde.

**Uvjet završetka:** izlazni kriterij M7 iz `docs/PROGRAM.md` (rekonstrukcija podudarna na svim scenarijima uključujući prazninu, nepodudarnost blokira predaju, isti sažetak, nema zabranjenih riječi, rok preko promjene sata, potpuna izjava, karta podrijetla bez zbroja); test iz M7.9 zelen u CI-ju. Koraci M7.11 i M7.12 (uvjetno) nisu dio uvjeta završetka, kao ni M7.6-P03 (uvjetno po D-263 Q27; pravilo T3, #87 c.6544288967). Karta podrijetla je u M7.Z2 (D-263 Q15), pa završetak M7.Z1 sam ne ispunjava ovaj uvjet.

#### M8 Uvoz i izvoz

**Cilj:** uvezeni tekst ulazi u rad kao označen događaj s izvorom, a rad se izvozi u obliku fakulteta. Odgovori O2, O4 i O5 za M8 zapisani su u D-290 do D-292 samo u dijelu koji ima vlasnikov trag; O1 i O3 su otvoreni (vidi „Otvoreno” niže).

**Gotovo na mainu:** ništa od uvoza ni izvoza DOCX-a i PDF-a.

| Korak   | Naziv                                                                                                                                                                                                                                                                                                                                                            | Uloga | Ovisi o                                                                             | Tiket                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------- | ----------------------------- |
| M8.0-S1 | Ugovor i plan napada uvoza: izvor „uvoz” u novoj verziji formata segmenta (D-290), `import_event` i manifest s tri hasha, granice (D-291), naziv datoteke (D-292), idempotentna potvrda pregleda                                                                                                                                                                 | B     | M8.1-P03, M8.0a                                                                     | DAN-436 (isti tiket kao M8.9) |
| M8.0-S2 | Ugovor i plan napada izvoza: `ExportSnapshot` nad spremljenom ili predanom revizijom, karta sposobnosti po čvoru iz M5, jedan manifest D-173 zajedno s M7.10-P01, opseg i rok trajanja izvoznog artefakta                                                                                                                                                        | B     | M8.0a, M5.0-S1 (DAN-589), M5.4 (DAN-403)                                            | DAN-636                       |
| M8.1    | Lokalni sintetički spike čitanja DOCX-a (D-198 t. 5)                                                                                                                                                                                                                                                                                                             | B     | M8.8                                                                                | DAN-242                       |
| M8.2    | Uvoz DOCX-a kao događaj s izvorom „uvoz”                                                                                                                                                                                                                                                                                                                         | B, F  | M8.1, M3.1, M8.0-S1                                                                 | DAN-396                       |
| M8.2b   | Prekidač „Dopušten uvoz” pri stvaranju zadatka; nova verzija zadatka smije uvoz samo isključiti (`docs/PRODUCT.md` §6 t. 3, D-282)                                                                                                                                                                                                                               | F     | M8.2-P04, M8.UX-R, M8.0-S1                                                          | DAN-396                       |
| M8.3    | Uvoz PDF-a kao događaj s izvorom                                                                                                                                                                                                                                                                                                                                 | B, F  | M8.2, M8.0-S1                                                                       | DAN-397                       |
| M8.4    | Izvoz DOCX-a u obliku fakulteta: P01 zamrznuti izvozni snapshot, P02 DOCX pisac bibliotekom `docx` (D-254)                                                                                                                                                                                                                                                       | B     | P01: M5.1-P04, M8.0-S2; P02: M5.4-P03, M8.4-P01 (provjera oblika: M4.3, D-203 t. 2) | DAN-398                       |
| M8.5-S  | Spike S-PDF (D-254): DOCX → PDF/A-2u preko LibreOfficea u izoliranom servisu bez mreže, OFL fontovi, pinana slika; 15.000 riječi, veraPDF `isCompliant="true"`, izmjereni CPU i RAM                                                                                                                                                                              | P     | M8.4-P02                                                                            | DAN-399                       |
| M8.5    | Izvoz PDF-a u obliku fakulteta prema D-254 (kanonski dokument → DOCX → PDF); renderer prema ishodu M8.5-S, a ako spike ne prođe, varijanta pdfkit ide vlasniku                                                                                                                                                                                                   | B     | M8.4-P01, M8.5-S                                                                    | DAN-399                       |
| M8.6    | Izvoz predanog rada, potvrde za referadu (R-06) i paket za Merlin (R-05); provjerljiv izvozni paket (D-173)                                                                                                                                                                                                                                                      | B, F  | M7.1                                                                                | DAN-316, DAN-341              |
| M8.7-S  | Spike čitanja skeniranih uputa: Tesseract.js `hrv` (brzi i standardni model) i tekstni sloj PDF.js nad sintetičkim hrvatskim uputama i bibliografijama; točnost dijakritika i datuma, vrijeme, veličina paketa                                                                                                                                                   | F     |                                                                                     | DAN-441                       |
| M8.7    | PDF izvori u bilježnici s isticanjem i citatom sa stranicom (S-09) te provjera doslovnog citata u učitanom PDF-u (A-03)                                                                                                                                                                                                                                          | F, B  | M5.1, M5.9, M8.3                                                                    | DAN-441                       |
| M8.8    | Paket, lockfile, OSV skeniranje i testovi za `spikes/docx-provenance`                                                                                                                                                                                                                                                                                            | P     |                                                                                     | DAN-435                       |
| M8.9    | Ugovor provenance i manifest uz `import_event`; `evidence-receipt-v2` se ne mijenja (D-198 t. 7)                                                                                                                                                                                                                                                                 | B     | M8.1, M8.2                                                                          | DAN-436                       |
| M8.10   | Tragovi u PDF-u i ODT-u, bez povijesti pisanja                                                                                                                                                                                                                                                                                                                   | B     | M8.3, M8.9                                                                          | DAN-437                       |
| M8.11   | Čitanje spremljenih verzija iz OneDrivea, SharePointa i Google Drivea za odabranu datoteku (D-198 t. 1; granica podataka i opseg dozvola po D-198 t. 5)                                                                                                                                                                                                          | B, F  | M8.2, M8.9                                                                          | DAN-438                       |
| M8.12   | Word i Google Docs dodaci, sljedeći val, ne pilot (D-198 t. 2; uvjet U-7)                                                                                                                                                                                                                                                                                        | B, F  | M8.11                                                                               | DAN-439                       |
| M8.13   | Ekran „Povijest dokumenta”: popis „uvezeno, tvrdnja iz datoteke”, isti za obje uloge (D-198 t. 6)                                                                                                                                                                                                                                                                | F     | M8.2, M8.9                                                                          | DAN-440                       |
| M8.14   | Izvoz PDF/A-2u; valjanost provjerava veraPDF u CI-ju s fiksnim profilom `-f 2u`, pinanom verzijom i digestom; PDF se označava kao PDF/A samo uz `isCompliant="true"`, inače obični PDF bez oznake (D-206, D-203 A3, D-253, D-284). P01: opcija nad istim snapshotom s `outputSha256` i `reportHash`; P02: veraPDF u CI-ju, test da veraPDF nije u `package.json` | B     | M8.5                                                                                | DAN-527                       |

Izvoz (M8.4, M8.5, M8.14) je u valu 1 (D-203 A3); uvozni opseg se ne mijenja.

**Ovisnosti izvan tablice:** M8.1-P03, M8.2-P04, M5.0-S1, M5.1-P04, M5.4-P03 i M8.UX-R navode se kako ih navodi plan M8 (M8.0a, DAN-601); M8.UX-R su referentne slike za S-19, S-20 i N-18 (DAN-603), M5.0-S1 je ugovor sheme v2 iz odjeljka M5 (DAN-589), a M5.4-P03 je opća izvozna projekcija bez paketa Lekte. Spike koraci (M8.5-S, M8.7-S) dijele tiket s korakom koji otvaraju.

**M8.0-S1 prije uvoza:** M8.2, M8.2b i M8.3 čekaju M8.0-S1 jer su polja `import_event`, manifest s tri hasha i idempotentna potvrda pregleda PRIJEDLOG do reviewa tog ugovora (D-290), granice čitanja osim `rawByteLength` predlaže taj ugovor (D-291), a pohrana naziva datoteke otvorena je do njega (D-292); uvoz se ne gradi na PRIJEDLOGU.

**M8.9 i M8.0-S1:** prema D-290 do D-292 sadržaj ugovora uvoza (`import_event`, manifest, granice, naziv datoteke) zaključuju ugovor M8.0-S1 i njegov review; oba koraka nose DAN-436. Zapisane odluke ne kažu je li M8.9 time zamijenjen ili ostaje zaseban kasniji korak, pa redak M8.9 i njegove ovisnosti (M8.1, M8.2) ostaju nepromijenjeni do odluke (vidi „Otvoreno”).

**Otvoreno:** O1 i O3 plana M8 (D-290 do D-292); granice čitanja osim `rawByteLength` (D-291); pohrana naziva datoteke (D-292). Zaključuje ih ugovor M8.0-S1 i njegov review, a što bi bilo skupo promijeniti ide vlasniku. **Za Owner queue:** je li M8.9 zamijenjen s M8.0-S1 ili ostaje zaseban korak nakon M8.2 (bilježenje uz `import_event`); o tome ovise ovisnosti M8.10, M8.11 i M8.13 o M8.9. Ne slijedi iz D-290 do D-292; do odluke se na M8.9 ne gradi ništa što bi bilo skupo promijeniti.

**Ekrani:** S-19 uvoz teksta, S-20 izvoz, N-18 izvoz predanog rada i paket za Merlin.

**Uvjet završetka:** izlazni kriterij M8 iz `docs/PROGRAM.md` (uvoz označen u evidenciji; izvoz DOCX-a, PDF-a i PDF/A prihvaćen prije nastavnog pilota, PDF/A-2u uz veraPDF `isCompliant="true"` (D-206); izvezeni DOCX prolazi Lektinu provjeru za FPZG profil kad stigne licenca, D-203 t. 2).

#### M9 AI pomoćnik

**Cilj:** student, kad zadatak to dopušta, koristi AI pomoćnika unutar Ductusa, a svako prenošenje teksta zapisano je s pružateljem, modelom i svrhom (pravilo 13). D-191 ga vraća u cilj programa, a D-194 uvodi u pilot (1. 3. 2027.) sa svim namjenama osim kineskih pružatelja i modela; ulazi u val 1 (D-199 t. 1). Odgovori O1 do O13 za M9 zapisani su u D-267 do D-270 (po vlasnikovoj delegaciji); model računa (O1) ostaje PRIJEDLOG.

**Gotovo na mainu:** pravilo AI-ja i dopuštene svrhe na kolegiju i zadatku (#943). **Nema:** posrednika prema pružatelju ni sučelja pomoćnika.

| Korak    | Naziv                                                                                                                                                                                                                                                                  | Uloga | Ovisi o                      | Tiket                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------- | --------------------- |
| M9.0-S1  | Jedan ugovor nove verzije formata evidencije za „import” (M8) i „ai-transfer” (M9) te podrijetlo lijepljenja; `evidence-receipt-v2` i formati v2 i v3 ostaju (D-269 O8)                                                                                                | B     | M3.1, M3.2-P03, M8.0-S1      | novo; nositelj M3     |
| M9.0-S2  | Port prema pružatelju i sintetički adapter; stvarni adapter tek nakon M9.1-P04; prazna konfiguracija troška znači da je AI isključen (D-267 O1, O5)                                                                                                                    | B     | M9.0-S1                      | novo                  |
| M9.0-S3  | Prekidač po ustanovi, isključen po zadanom, za transkripciju i alate pružatelja; pretraga weba samo kroz Ductusov alat s poslužiteljskim popisom odredišta; bez gumba za snimanje (D-267 O9, O10)                                                                      | B     | M9.0-S2                      | novo                  |
| M9.UX    | Referentne slike za S-16 panel Asistent, po D-183 (D-269 O7)                                                                                                                                                                                                           | F     |                              | novo                  |
| M9.UX-R  | Odobrenje slika S-16 od vlasnika; UI koraci M9 čekaju ga, backend ne (D-269 O7)                                                                                                                                                                                        | V     | M9.UX                        | novo; radnja vlasnika |
| M9.PRIV  | Privatnost: pitanje FPZG-u o „objašnjenju pojma” (D-264 Q09, D-268 O2), pravno mišljenje i DPIA (D-257) kao uvjet uključivanja prekidača iz M9.0-S3                                                                                                                    | V     |                              | novo; radnja vlasnika |
| M9.AIACT | Klasifikacija AI pomoćnika prema Aktu o umjetnoj inteligenciji (D-256) prije uključivanja za stvarne studente                                                                                                                                                          | V     | M9.PRIV                      | novo                  |
| M9.1     | Izbor pružatelja, model računa i ugovorni model (D-194 t. 6 i 7, PRIJEDLOG; razlog D-77), uz pravno mišljenje i DPIA. Rok 15. 12. 2026., kontrolna točka 30. 11. (D-270 O12)                                                                                           | V     |                              | DAN-400               |
| M9.2     | Posrednik prema pružatelju: `provider.only`, ograničenje troška, tajne po modelu računa koji se odluči (D-74 pod preispitivanjem, D-194)                                                                                                                               | B     | M9.1                         | DAN-401               |
| M9.3     | Dopušteni pružatelji po fakultetu i zadatku; popis iz verzionirane konfiguracije `config/faculties`, potvrda FPZG-a (D-270 O11)                                                                                                                                        | B     | M2.12, M9.2                  | DAN-402               |
| M9.4     | Panel Asistent i prenošenje teksta s bilježenjem pružatelja, modela i svrhe (D-42); ponovna primjena bez mreže samo uz aktualnu provjeru prava (D-268 O4); katalog od 10 svrha (D-268 O2)                                                                              | F, B  | M9.3, M3.1, M9.0-S1, M9.UX-R | DAN-411               |
| M9.5     | Razgovori priloženi uz izjavu; nepriloženi nisu vidljivi nastavniku (D-41); prijenos teksta koji je kasnije obrisan i dalje čini razgovor obveznim (D-268 O3, D-263 Q22)                                                                                               | B, F  | M9.4, M7.5                   | DAN-412               |
| M9.6     | Zaštita brojki i citata pri lekturi (D-46); poznato podrijetlo i podudaranje s odgovorom pomoćnika (D-58; oznaka podudaranja je uvjetna, U-4); oznaka ostaje isključena do M9.6-P04 nakon pilota, poznati prijenos i podrijetlo lijepljenja vrijede bez nje (D-268 O6) | B, F  | M9.4                         | DAN-413               |
| M9.7     | Svrhe razine 2 nedostupne dok ih nastavnik ne uključi, uključujući „objašnjenje pojma” (D-268 O2); pomoćnik koji pita (D-64)                                                                                                                                           | F, B  | M9.4                         | DAN-414               |

**Ekrani:** S-16 panel Asistent. N-19 (AI pomoć nastavniku) je PRIJEDLOG i ne gradi se.

**Zatvaranje M9:**

| Korak | Naziv                                                                                                                                                                                                                                                                                                     | Uloga | Ovisi o                | Tiket |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------- | ----- |
| M9.Z1 | Provjera cjeline M9 na sintetičkim podacima: svaki prijenos zapisan s pružateljem, modelom i svrhom; prekidači isključeni po zadanom; prazna konfiguracija troška isključuje AI                                                                                                                           | B     | M9.4, M9.5, M9.6, M9.7 | novo  |
| M9.Z2 | Stanje na kontrolnoj točki 15. 1. 2027. i prijava vlasniku što je otvoreno (M9.1, M9.PRIV, M9.AIACT, M9.UX-R); M9 se ne reže bez vlasnika (D-199 t. 6, D-270 O12). Izvještaj je vezan za datum, ne za završetak koraka: ne čeka ni M9.1 (o njegovu stanju izvještava) ni M9.Z1 (zasebna završna provjera) | V     |                        | novo  |

**Ovisnosti izvan M9:** M3.1 (B-8) i M3.2-P03 (nositelj formata evidencije) te M8.0-S1 (zajednički ugovor formata, D-269 O8) navode se kako ih navodi objedinjeni plan rb27; naziva M3.2-P03 još nema u ovom dokumentu (M8.0-S1 je u odjeljku M8), a tiketi se otvaraju nakon potvrde plana (M9.0b, D-270 O13). M7.5 je preduvjet za M9.5. **Redoslijed i rokovi (D-199 t. 6, D-266 t. 6):** M10 → M9 → M11; M9.1 do 15. 12. 2026., M9.2 i M9.3 oko 15. 1. 2027., M9.4 do M9.7 do 15. 2. 2027. (M9.5 nakon M7.5), M10 oko 10. 2., M11 22. 2.; kontrolne točke 30. 11. 2026. i 15. 1. 2027.

**Uvjet završetka:** izlazni kriterij M9 iz `docs/PROGRAM.md`, bez oznake podudaranja s odgovorom AI pomoćnika iz M9.6 (D-58, uvjet U-4): ta oznaka (stavka „prepisan AI odgovor označen” u izlaznom kriteriju) nije dio uvjeta završetka M9 dok se U-4 ne riješi.

#### M10 Podaci

**Cilj:** podaci se čuvaju po klasama i rokovima, brišu se po roku tako da lanac ostaje provjerljiv, i mogu se izvesti. Odgovori MQ01 do MQ16 za M10 zapisani su u D-271 do D-275 (po vlasnikovoj delegaciji); rokovi čuvanja ostaju PRIJEDLOG do potvrde FPZG-a (D-30).

**Gotovo na mainu:** revizijski trag pristupa (pgTAP 080 do 083), upisa i članstva. **Nema:** klasa podataka, brisanja po roku, pravnog zadržavanja ni izvoza za studenta.

| Korak    | Naziv                                                                                                                                                                                                                                                                        | Uloga | Ovisi o                                        | Tiket                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------- | ----------------------------------------- |
| M10.0-S1 | Jedan ugovor brisanja: tablica `erasure` samo za dodavanje (nadgrobni zapis), uske SECURITY DEFINER funkcije samo za `ductus_retention`, zasebna migracija koja sužava okidač nad `audit.access_log`, potpisana kontrolna točka evidencije brisanja (D-272 MQ04, MQ05, MQ07) | B     | M3.2-P03                                       | novo                                      |
| M10.0-S2 | Raspored u workeru (pg-boss) s prvim poslom `purge_ended_sessions`; prije potvrde D-30 izvršavaju se samo već odlučeni poslovi, ostalo je probni prolaz (D-273 MQ08, MQ14)                                                                                                   | B     | M10.0-S1                                       | novo                                      |
| M10.1    | Rokovi čuvanja s FPZG-om (D-30); popis DATA-CLASS od 30 klasa u 8 kategorija (C-21) nad mainom u trenutku izrade (M10.1-P01, D-271 MQ01, MQ03); tiket prati D-264 Q11 (D-275 MQ16)                                                                                           | V     | FPZG                                           | Owner queue                               |
| M10.2    | Klase podataka i brisanje po roku, uključujući stanje prikaza uživo, verzije i vrijeme po promjeni; hash i potvrde se čuvaju zasebno, radi dokaza predaje (D-272 MQ06)                                                                                                       | B     | M10.1, M10.0-S1, B0.1 (bucket kontrolne točke) | DAN-297                                   |
| M10.3    | Pravno zadržavanje (F-02); postavlja ga admin ustanove s referencom (broj slučaja), skida drugi admin ili operater, više zadržavanja vrijedi neovisno (D-274 MQ11)                                                                                                           | B     | M10.2                                          | DAN-415                                   |
| M10.4    | Student vidi tko je i kada otvorio njegov rad (pravilo 17, C4); M10.4-P02 popisuje sve putove koji vraćaju sadržaj ili sažetak, retci po 5 minuta grupirani po danu, bez zbroja posjeta i trajanja (D-274 MQ10)                                                              | B, F  | M3.11                                          | DAN-294                                   |
| M10.5    | Izvoz za studenta i za bivšeg studenta preko referade: referada prima zahtjev i provjerava identitet, admin ustanove pokreće posao s referencom, jednokratna poveznica na 24 h (D-271 MQ02)                                                                                  | B, F  | M8.6, M3.11                                    | DAN-316 (dio)                             |
| M10.6    | Izlaz iz usluge: izvoz svih podataka fakulteta (F-04); pokreće operater na pisani zahtjev ustanove, bez brisanja; P01 ugovor u valu 3, P02 i P03 nakon pilota a prije njegova kraja (D-274 MQ12)                                                                             | B     | M10.5                                          | DAN-416                                   |
| M10.7    | Administracija čuvanja, pravnog zadržavanja i revizijskog traga                                                                                                                                                                                                              | F     | M10.2, M2.11                                   | DAN-417                                   |
| M10.8    | (uvjetno) Studentova vlastita povijest rada (D-131); ne gradi se do pravnog mišljenja (D-55) i potvrde C-19, klasa 12 ostaje rezervirana u DATA-CLASS (D-274 MQ09, uvjet U-8)                                                                                                | B, F  | pravno mišljenje D-55, C-19, uvjet U-8         | DAN-424                                   |
| M10.9    | (uvjetno) Paket za zaštitu studenta: proširenje prenosivog zapisa (D-49, S-01 iz `docs/FEATURES.md`; ekran S-46 paket zaštite)                                                                                                                                               | B, F  | M7.10, M10.5, uvjet U-5                        | novo                                      |
| M10.10   | (uvjetno) Izvješće za evaluaciju smjernica (F-01, FPZG čl. 13), samo agregati                                                                                                                                                                                                | B, F  | M6.10, M10.7, uvjet U-6                        | novo                                      |
| M10.11   | Portfelj nakon studija: izvoz predanog rada za portfelj (S-10)                                                                                                                                                                                                               | B, F  | M8.6, M10.5                                    | novo                                      |
| M10.UX-R | Odobrenje referentnih slika ekrana M10 od vlasnika, prije UI koraka (D-183, `docs/SESSIONS.md` §6)                                                                                                                                                                           | V     |                                                | novo; radnja vlasnika                     |
| M10.PRIV | Privatnost: potvrda rokova i hasha (D-264 Q09, Q11), postupak provjere identiteta u referadi (D-271 MQ02), klauzula o izlazu u ugovoru o obradi (D-264 Q13)                                                                                                                  | V     |                                                | novo; radnja vlasnika                     |
| M10.Z1   | Proba povrata na sintetičkom obliku: kontrolna točka evidencije brisanja mora se podudarati prije otvaranja povrata (D-272 MQ07, D-273 MQ15)                                                                                                                                 | B     | M10.2, M10.3                                   | novo                                      |
| M10.Z2   | Proba povrata na stagingu sa stvarnom infrastrukturom u valu 3 (D-273 MQ15)                                                                                                                                                                                                  | P     | M10.Z1, B0.1                                   | novo; računi i staging su radnja vlasnika |

**Ekrani:** S-18 vlastita povijest rada, S-42 dnevnik pristupa, S-44 izvoz vlastitih podataka, A-05 čuvanje i pravno zadržavanje, A-06 revizijski trag pristupa, A-08 izlaz iz usluge.

**Proba povrata:** M10 ne gradi zasebnu skriptu. Nositelj je M11.2-P04 u `scripts/operations/restore-drill/`; M10.2-P06b dodaje scenarij brisanja u istu skriptu, a M10.Z2 je koristi na stvarnoj infrastrukturi (D-277 NQ05).

**Uvjet završetka:** izlazni kriterij M10 iz `docs/PROGRAM.md` (brisanje po roku testirano; lanac provjerljiv nakon brisanja sadržaja); pravno zadržavanje zaustavlja brisanje (test). Koraci M10.8, M10.9 i M10.10 (uvjetno) nisu dio uvjeta završetka.

#### M11 GO uvjeti

**Cilj:** produkcija i staging u EU-u s dokazanim povratom, pravnim dokumentima, pristupačnošću i operacijama, tako da je svaki GO uvjet iz `docs/PROGRAM.md` zelen.

**Gotovo na mainu:** axe E2E; test bez lažnog pružatelja u produkcijskom buildu; mapa `docs/privacy/`; `docs/OPERATIONS.md` (DAN-540). **Nema:** produkcijske i staging konfiguracije, statusne stranice, engleskog kataloga sučelja.

| Korak  | Naziv                                                                                                                                                                                                                                                                         | Uloga | Ovisi o                | Tiket                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------- | --------------------------- |
| M11.1  | Računi dobavljača i spike B0.1 (PITR, RTT, KMS); DAN-52 ostaje uski tiket za objektnu pohranu (M11.1-P03), kišobran B0.1 za M11.1-P01 i P02 otvara orkestrator (D-277 NQ04). Računi su radnja vlasnika (D-278 NQ18)                                                           | V, P  | računi                 | DAN-52                      |
| M11.2  | Produkcijski Dockerfile, Caddy, OpenTofu, proba povrata baze i bucketa; jedini nositelj probe povrata je M11.2-P04 u `scripts/operations/restore-drill/`; D-91 t. 3 je spojen preko #1051, M11.2-P03 samo za eventualni ostatak (D-277 NQ05, NQ07)                            | P     | M11.1                  | DAN-298                     |
| M11.3  | Health i readiness, provjera okoline pri pokretanju, strukturirani log u `src/server/log/`, kostur `docs/OPERATIONS.md`; DAN-299 ostaje Done, ostatak ide u tri uska nova tiketa (D-277 NQ03, NQ06)                                                                           | P, B  |                        | DAN-299                     |
| M11.4  | Staging s AAI@EduHr Labom i sintetički prolaz evidencije na istim vrstama resursa                                                                                                                                                                                             | P     | M11.2, M1.2            | DAN-426                     |
| M11.5  | Sučelje na engleskom (D-70) i postavke profila                                                                                                                                                                                                                                | F     |                        | DAN-427                     |
| M11.6  | Pristupačnost WCAG 2.2 AA (D-276 NQ01, D-248), ručna provjera čitačem zaslona i izjava o pristupačnosti u obliku koji traži hrvatski propis, uz poziv na EN 301 549 (F-03)                                                                                                    | F     |                        | DAN-428                     |
| M11.7  | Statusna stranica i postupak incidenta (F-10 iz `docs/FEATURES.md`)                                                                                                                                                                                                           | P     | M11.2                  | DAN-429                     |
| M11.8  | Obavijest o privatnosti, DPIA, ugovor o obradi i popis podizvršitelja s DPA-ima; DAN-430 dijele M9.PRIV i M11.8, jedan nositelj dokumenta je M11.8-P01 (D-278 NQ11)                                                                                                           | V     | FPZG, pravno mišljenje | DAN-430                     |
| M11.9  | Prije pilota: nadzor i uzbune, build bez source mapa, vanjski penetracijski test, ograničenja zahtjeva, SBOM                                                                                                                                                                  | P, B  | M11.2                  | DAN-184 do DAN-187, DAN-322 |
| M11.10 | „Prijavi problem”, mobilni prikaz svih ekrana, stranica „Kako Ductura radi”                                                                                                                                                                                                   | F     |                        | DAN-431                     |
| M11.11 | Licenca, uvjeti korištenja i odluka o vidljivosti repoa; M11.11-P01 priprema licencu, uvjete i popis onoga što ne smije biti javno, odluka je vlasnikova uz pravnika (D-277 NQ02)                                                                                             | V     |                        | DAN-188                     |
| M11.12 | Brze bilješke s mobitela u bilježnicu projekta (S-03). Bilješka koja ulazi u rad je promjena dokumenta s vrstom izvora „mobilna bilješka” (pravilo 8). Nije GO uvjet i ne blokira M11.Z1; gradi se u valu 3 samo ako ostane kapaciteta, inače odmah nakon pilota (D-277 NQ09) | F, B  | M5.9, M11.10           | novo                        |

**Ekrani:** A-07 integracije i status AAI@EduHr, A-09 zdravlje sustava i kopije, J-01 naslovnica, J-02 kako Ductura radi, J-05 statusna stranica i izjava o pristupačnosti, Z-09 postavke, Z-10 prijavi problem, Z-12 mobilni prikaz.

**Odgovori NQ01 do NQ18:** zapisani su u D-276 do D-279. Nadzor u pilotu bez novog vanjskog pružatelja praćenja grešaka: uzbune dolaze iz vlastitih provjera (spremnost, crveni worker, rok predaje) i prikaza u aplikaciji; vanjski pružatelj ide kroz M11.8-P02 uz unos na popis podizvršitelja i DPA (D-277 NQ10). Rizik M11.5-P02 (postavke profila) i M11.10-P01 (tablica prijava) podignut je na critical (D-278 NQ14). Pentest ide u rani val 3, nakon M11.4-P01 i M11.9-P03, samo nad stagingom (D-278 NQ16). Radnje vlasnika (paket zahtjeva FPZG-u, pentest, pravna osoba i ugovor o obradi, računi B0.1, licenca i vidljivost) ostaju otvorene u Owner queueu.

**Uvjet završetka:** svaki redak tablice „GO uvjeti za stvarne studente” u `docs/PROGRAM.md` zelen i zapisan s dokazom.

#### Uvjetni koraci (val 3, T3)

Sadržaj vala 3 raspoređen je po fazama prema odluci orkestratora T3 (#87 c.6544288967, opcija C; delegirano u #87 c.6543799262, t. 3): stavke bez vanjskog preduvjeta su koraci svojih faza (M5.14 do M5.15, M6.11, M7.13, M8.7, M10.11, M11.12), a već raspoređene stavke ostaju gdje jesu (M6.9 konzultacije, M6.10 zbirni pregled, M7.6 vremeplov, M7.10 prenosiv zapis, M8.3 uvoz PDF-a, M5.7 provjera izvora, M6.2 reprodukcija s poviješću odlomka, M10.8 povijest rada, od D-274 MQ09 uvjetna i bez osnovnog prijema). Stavke ispod imaju pravni ili ustavni uvjet, ne grade se dok se on ne riješi i nisu dio uvjeta završetka svoje faze. Odluku o svakom uvjetu donosi vlasnik.

| Uvjet | Koraci         | Što treba riješiti                                                                                                                                                                                               | Granica                           |
| ----- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| U-1   | M6.12          | Što komentor i povjerenstvo smiju vidjeti (tekst, sažetak, reprodukciju, prikaz uživo) i hoće li se mijenjati PRODUCT §3 i §5 pravilo 7. Model u M2.8 ostaje; sučelje čeka.                                      | Ustav C-23, D-154, pravilo 7      |
| U-2   | M6.13 do M6.15 | Pravno mišljenje D-55 i vlasnikova zasebna odluka o gradnji (D-136). Dio „Bilješka mentora” u M6.9 (D-47) vrijedi pod istim uvjetom (D-135).                                                                     | D-130, D-135, D-136               |
| U-3   | M7.11, M7.12   | Vlasnik potvrđuje tekst kriterija prihvaćanja: popis mjesta je činjenica, bez rangiranja, težine ni zbroja; „razgovor održan” bez ocjene; student vidi identičan popis.                                          | PRODUCT §5 pravila 1, 2, 3, 5, 13 |
| U-4   | dio M9.6       | Oznaka „podudara se s odgovorom AI pomoćnika” ostaje oznaka mjesta, ne tvrdnja o autoru.                                                                                                                         | pravilo 1 (C-9, C-10); D-194      |
| U-5   | M10.9          | Tekst paketa i QR provjere ne smije tvrditi autorstvo; dokument izlazi izvan sustava.                                                                                                                            | pravilo 9, C-13                   |
| U-6   | M10.10         | Agregati bez rizika, ranga i ocjena; isti prag od najmanje 5 studenata kao N-11.                                                                                                                                 | pravilo 2                         |
| U-7   | M8.12          | Dodaci idu u sljedeći val, ne u pilot (D-198 t. 2, ODLUČENO 1. 11. 2026.). Prije gradnje pisana potvrda FPZG-a, pravno mišljenje, DPIA i provjera ograničenja Microsofta i Googlea. Do tada vrijede D-79 i D-80. | D-79, D-80                        |
| U-8   | M10.8          | Pravno mišljenje D-55 (razmjernost čuvanja obrisanog teksta) i potvrda C-19. Do tada se ne gradi, a klasa 12 ostaje rezervirana u DATA-CLASS. DAN-424 i DAN-463 se ne udvostručuju.                              | D-131, D-55, D-274 MQ09           |

Planer (M5.15) i „Moj rad u brojkama” (M7.13) više nisu uvjetni prema odluci vlasnika o D-63 („1. da 2. da”, #87), ali izričiti izuzetak u PRODUCT §5 pravilu 4 (napredak po poglavlju, dani do roka, napredak iz verzija) upisuje tek docs PR #1030: **M5.15 i M7.13 ne počinju prije spajanja #1030.** A-08 (dnevni vremenski žig kod vanjskog pružatelja) ostaje izvan rasporeda.

#### Ekrani izvan faza

Ovi ekrani iz mape nemaju mjesto u tablici faza i ne grade se dok vlasnik ne odluči: K-01 koordinator (zbrojevi po kolegiju), K-02 odobrenje istrage (mapa bilježi sukob s D-143 i D-154), A-10 slučajevi i paket dokaza, J-04 stranice za fakultete i nabavu.

#### Otvorena pitanja za vlasnika

1. ~~Novi raspored i datum pilota.~~ Riješeno 1. 11. 2026.: pilot 1. 3. 2027. (D-194 t. 1), raspored D-199 t. 6 (#87 c.6551869348). Izmijenjeno D-203 E3: kod vala 1 spreman 22. 2. 2027., zatim proba od oko četiri tjedna; nastavna aktivacija oko 22. 3. 2027. ili poslije, uz prihvat i suglasnost FPZG-a. Datum 1. 3. 2027. ostaje kao trag.
2. M9: AI pomoćnik ulazi u pilot (D-194 t. 1, odlučeno), i to u val 1 (D-199 t. 1). Otvoreno ostaje: model računa, ugovorni model i izbor pružatelja (D-194 t. 6 i 7, PRIJEDLOG, uz pravno mišljenje i DPIA; `docs/privacy/05` t. 23 do 28).
3. ~~Raspored sadržaja vala 3 po fazama.~~ Riješeno 31. 10. 2026. odlukom orkestratora T3 (#87 c.6544288967): koraci u fazama M5 do M11, uvjetni koraci u odjeljku „Uvjetni koraci”. Preostaju pitanja U-1 do U-6 vlasniku, uz faze kojih se tiču.
4. Ekrani bez faze: K-01, K-02, A-10, J-04. Grade li se, i u kojoj fazi?
5. ~~Panel Nacrt (S-14: obrnuti nacrt, nit argumenta, pojmovnik).~~ Djelomično riješeno 31. 10. 2026.: ulazi u program (#87 c.6543799262, t. 5); koraci M5.14a do M5.14c prema `docs/design/PANEL-NACRT-SPEC.md` kao okvir. Riješeno 2. 11. 2026. (D-234): smještaj, pohrana, vidljivost, naziv i podjela (pitanja 1, 2, 3, 4, 6 i 9). Pitanja 5, 7 i 8 iz specifikacije ostaju PRIJEDLOG.
6. D-63 (napredak i „preskočena stanka”) prema D-56 i pravilu 4 (DAN-104).
7. Kriteriji popisa „tko treba pomoć” (N-12, DAN-102).
8. ~~RPC za dodjelu mentorstva (D-182 t. 1 čeka odluku nakon demoa; M2.6).~~ Riješeno 2. 11. 2026. (D-204): mentorstvo nastaje kad nastavnik odobri studentov rad; administrator ga ne dodjeljuje.
9. ~~Izlazni kriterij M0 „isti broj testova kao u izvoru”.~~ Riješeno 31. 10. 2026. odlukom vlasnika (#87 c.6547174354): umjesto broja vrijedi zapis jednakovrijednosti za svaki neprenesen izvorni slučaj (`docs/engineering/prijenos-jezgre-M0.1-jednakovrijednost.md`); nepokriveno se vraća kao test.
10. Sastav backend dodatka (otvoreno pitanje uz D-99) gubi rok 16. 11. 2026. s rasporedom po valovima; rješava li se uz novi raspored.
11. M8 Document Provenance (D-198): rok čuvanja uvezenih verzija uz FPZG DPO i pravno mišljenje (t. 3). Dodaci za Word i Google Docs odlučeni su za sljedeći val (t. 2, U-7).
12. Uloge nastavnika i mentora (D-204). D-154 kaže da su mentor i nastavnik zadatka „jedna uloga općenito”, a D-204 da je ista osoba nastavnik na kolegiju i mentor na pisanom radu. Je li to jedna potvrđena uloga `teacher` s dva odnosa (kolegij, mentorstvo) ili dvije uloge, i treba li izmijeniti D-154? `docs/PRODUCT.md` §3 još navodi da administrator „potvrđuje ulogu nastavnika i mentora” i ulaz „dodjelom mentoru”, a popis vrsta mentorskog rada (završni, diplomski, specijalistički, doktorski) razlikuje se od D-204 (esej, završni, diplomski i drugi). Otvoreno je i što se događa s mentorstvima kad se nastavniku opozove uloga (D-200 P7). Točka 2 odluke o ulogama od 31. 10. 2026. (povjerenstvo u istrazi) čeka izmjenu Ustava.
13. Trajanje produljene probe D-196 (D-205 t. 5): zapis ne navodi novi završni datum. Traje li do jezgre M2 (30. 11. 2026.) ili do kraja M2 (20. 12. 2026.)? `docs/ORKESTRATOR.md` §4a još navodi „do 14. 11. 2026.”.

### Podatkovni i korisnički tokovi

Prilog zahtjeva iz [izvorne revizije](https://github.com/ductura/.github/blob/265ea93a2e14a22902e17d259e31304278c30982/docs/ductus/engineering/PLAN-TOKOVI-2026-10-25.md). Datirani rasporedi i povijesni opisi služe sljedivosti.

> **For agentic workers:** pri eventualnom izvršenju koristiti superpowers:executing-plans i aktualni projektni ugovor. Ovaj plan ne pokreće sesije, ne delegira posao i ne daje ovlast za implementaciju, merge, deploy ili migraciju produkcije. Neovisni review i QA ostaju prema Engineering Systemu.

**Goal:** povezati postojeću Ducturinu jezgru u cjelovite studentske, nastavničke i administratorske tokove te odrediti konkretan put do operaterskog prostora.

**Architecture:** zadržati postojeći Next.js modularni monolit, PostgreSQL/RLS, withActor, API rute, Tiptap i Dexie. Serverske stranice čitaju postojeće serverske adaptere; HTTP rute dodaju se za korisničke mutacije i dohvat koji je stvarno potreban klijentu. Novi podaci i ovlasti uvode se samo za funkcije kojima postojeći model nije dovoljan.

**Tech Stack:** Node >=24, pnpm 10.33.0, Next.js 15.5.28, React 19.3.1, TypeScript, PostgreSQL/pg, Tiptap, Dexie, Vitest, pgTAP i Playwright prema pregledanom package.json. Zaključane inačice izvršitelj uzima iz aktualnog lockfilea.

**Spec:** repo dokumenti AGENTS.md, CLAUDE.md, STATE.md, docs/PRODUCT.md, ARCHITECTURE.md, BACKEND.md, PROGRAM.md, PLAN-DEMO.md, DECISIONS.md, TESTING.md i usvojeni dizajn docs/design/ductura. Protokol koordinacije je u Linearu.

**Datum i baza:** 25. 10. 2026.; main `5cd9cf8f28bca2804511db4ea166eb0c5c647250`. Osvježenje u odnosu na prethodni audit donijelo je samo promjenu teksta pragova i pripadajućeg testa (#741); ostali pregledani izvori ostali su isti.

**Način rada:** PLAN, bez promjene repoa ili Lineara. Nisu izvršeni aplikacija, lokalni testovi ni neovisni QA. Sve naredbe u nastavku su upute za budućeg izvršitelja, a svi očekivani ishodi su kriteriji, ne ostvareni PASS.

#### 1. Global Constraints

- Linear određuje zadatak, prioritet, nositelja, rok, status i predaju. GitHub/repo određuje prihvaćene odluke i izvedbene dokaze.
- Oznake A1–E3 u ovom dokumentu označavaju redoslijed plana, a ne nove identifikatore zadataka ili dodatni statusni registar.
- Postojeći zadatak dopunjuje se prije otvaranja novog. Novi zadatak u Linearu predlaže se samo gdje u pregledu nije nađen pokriven opseg.
- Prije izvršenja: aktualni opis i komentari, aktivne rezervacije, PREUZETO, izolirani worktree, dodijeljene putanje. Završetak: PREDAJA s bazom/HEAD-om, dokazima i preostalim poslom.
- Prijava studenta ostaje isključivo AAI@EduHr. Lažni OIDC dopušten je samo lokalno i u CI-ju. Identitet nije e-mail.
- Akter dolazi iz serverske sesije i current_actor(); studentId, institutionId ili role iz zahtjeva nikad ne daju ovlast.
- Klijent ne piše izravno u tablice evidencije, predaje ni audita. Nove tablice imaju FORCE RLS i odgovarajuću pgTAP matricu.
- SECURITY DEFINER ima prazan search_path i uske EXECUTE grantove; nema proširivanja ductus_app na superuser/BYPASSRLS.
- Student vidi istu dopuštenu projekciju svoga rada kao nastavnik. Administrator ustanove i operater nemaju zadani pristup sadržaju rada.
- Nema procjene autorstva, AI postotaka, rizika osobe, rangiranja studenata ili zaključivanja o trudu.
- Spremljeno na poslužitelju označava samo potvrđenu evidenciju uz provjeren potpis. Live prikaz i trajna evidencija imaju različite ugovore.
- D-166: spašena kopija ostaje uz račun i rad dok je autor izričito ne vrati ili odbaci; odjava uvijek zatvara sesiju.
- D-167: /rad bez zadatka je slobodan lokalni nacrt bez predaje. Pisanje nakon roka ostaje dopušteno; predaja dobiva odgovarajuću oznaku.
- D-107/D-108/D-114: demo ima prednost; ovaj plan ne mijenja proces, gateove ili tooling. Zamrzavanje opsega 28. 10. i cilj demoa 2. 11. ostaju.
- D-168: WebKit/Safari odgođen je nakon demoa; prije stvarnog pilota vrijede aktualni puni browser uvjeti.
- Trenutačni CSS v3 i postojeći CSS moduli polazište su za nove ekrane. Koriste se postojeći tokeni, fontovi i komponente.
- Svi testni korisnici i dokumenti su sintetički; tajne, stvarni studentski tekstovi i sirovi auth tragovi ne ulaze u dokaze.
- Risk i neovisnost određuje aktualni Engineering System, uključujući automatski risk floor. Ovaj plan ne uvodi novi formalni gate.

#### 2. Review Focus

Pet najvažnijih rubnih slučajeva koje konkretni koraci moraju pokriti:

1. Prelazak iste osobe između dva zadatka: dokument, journal, komentar i predaja ostaju vezani uz isti zadatak. Vlasnik testa: A1.
2. Lokalni nacrt noviji od poslužiteljske revizije: nema tihog prepisivanja, lažnog SYNCED-a ni prešućivanja razlike pri predaji. Vlasnici: A2 i B4.
3. Opoziv prava ili promjena računa dok je ekran otvoren: sljedeći pristup se odbija, stari sadržaj se uklanja prema postojećem session ugovoru. Vlasnici: A2 i C3.
4. Nova verzija zadatka ili produljenje roka: stara potvrda i vrijeme već izvršene predaje ne mijenjaju se retroaktivno. Vlasnici: B7–B9.
5. Nepotpuni podaci, nepoznat status i istek sesije: UI ne prikazuje lažnu praznu listu, nulu ili uspjeh niti otkriva tuđi resurs. Vlasnici: B1, B2, C1 i E1.

#### 3. Stvarno postojeće i potrebno proširenje

| Cjelina               | Postojeće u pregledanom mainu                                                                                         | Potrebno                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Baza                  | 34 migracije; identity, institution, evidence, collaboration i audit; RLS i RPC-i                                     | Nove projekcije, ciljane rute i nekoliko domenskih proširenja      |
| Studentski editor     | /rad, LocalDocument, journal, komentari, lokalno spremanje, live publisher                                            | Završiti stvarni dokument zadatka i spoj trajne evidencije         |
| Otvaranje rada        | readWorkDocument, readWorkContext, POST /api/evidence/open                                                            | Iskoristiti iste rezultate u svim površinama rada                  |
| Sinkronizacija        | AtomicDexieJournal.startEvidence/adoptServerEvidence, createDrainRunner, createEvidenceTransport, evidenceVerifierFor | Povezati stvarnog UI pozivatelja prema postojećem 3d-2c ugovoru    |
| Nastavnički ulaz      | /nastavnik i readTeacherCourses                                                                                       | Detalj kolegija/zadatka i navigacija do radova                     |
| Veza zadatak → radovi | readAssignmentWorks i app.assignment_works                                                                            | F2 poveznice; kasnije puna projekcija predaja i studenata bez rada |
| Novi kolegij/zadatak  | TeacherSetup i postojeći createAssignment/course API                                                                  | Samostalno stvaranje zadatka u postojećem kolegiju                 |
| Predaja               | /rad/[assignmentId]/predaja, Submission, POST /api/submission                                                         | Završiti povezani tok; dopuniti postojeće auditne zadatke          |
| Uloge                 | institution_role, confirm/revoke teacher; navigacija teacher/student                                                  | Minimalni institucijski admin i dopuštene projekcije korisnika     |
| Dorade                | Čisti domenski automat revision-request.ts sa 6 stanja                                                                | Trajna pohrana, serverska autorizacija i UI                        |
| Obavijesti            | N-01/N-02 u prihvaćenom FEATURES/PROGRAM                                                                              | Događaji, korisnički inbox, postavke i kasnije isporuka e-poštom   |
| Dizajn                | v3 tokeni, AppShell, WorkspaceShell, fontovi, responsive i axe                                                        | Završiti postojeće popravke i provjeriti nove tokove               |

**Baza ostaje jedna po prihvaćenom modelu, s odvojenim ovlastima i granicama ustanova.** Novi studentski dashboard ne traži novu bazu ni preseljenje na Supabase Auth. Objavljena instanca i primijenjene produkcijske migracije nisu provjerene ovim planom.

#### 4. Mapa postojećih zadataka i aktivnog rada

| Opseg                                        | Primarni postojeći trag                 | Uputa za izvršenje                                                        |
| -------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| Dokument zadatka, stari lokalni nacrt, F2    | DAN-89; GitHub #711; otvoren #731       | Nastaviti postojeći ugovor, bez drugog F1 writera                         |
| Potpisana sinkronizacija, bootstrap/recovery | DAN-37, DAN-49, DAN-285; #476 3d-2c     | Provjeriti stvarne dodjele; #734 je uski hardening, ne cijela integracija |
| Puni K-4                                     | DAN-89, DAN-232; #655; otvoren #726     | Otvoreni PR ne znači izvršeni prihvatni tok                               |
| Predana revizija, zatvaranje paketa          | DAN-289                                 | Dopuniti postojeći zadatak povezivanjem UI-ja                             |
| Popis svih predaja                           | DAN-290                                 | Dodati roster/projekciju prije punog dashboarda                           |
| Jednom izdana potvrda                        | DAN-291                                 | Iskoristiti postojeći receipt storage; ne uvoditi drugi potpisni put      |
| Administrativne i verzijske rute             | DAN-292                                 | Podijeliti po postojećim RPC-ovima i provjerljivim radnjama               |
| Snimke/verzije rada                          | DAN-293                                 | Dodati čitanje s provjerom hasha i pravima vidljivosti                    |
| Studentov dnevnik pristupa                   | DAN-294; prethodni DAN-228 Done         | DAN-228 nije dokaz dovršenog studentskog prikaza                          |
| Retention, infrastruktura i operacije        | DAN-297, DAN-298, DAN-299               | Ovisnosti za pilot; zasebno od izgleda frontend ekrana                    |
| Odjava i spašene kopije                      | DAN-288; otvoren #751                   | Usuglasiti s D-166 i budućim radom s više dokumenata                      |
| Dizajnerski popravci                         | #732; #742, #750; DAN-214/281           | #740 i #741 su već na mainu; ne ponavljati ih                             |
| Studentski dashboard                         | GitHub #335                             | Pronaći/proširiti odgovarajući Linear opseg; po potrebi tek onda novi DAN |
| Task wizard, roster, admin, policy           | GitHub #337, #327/#338, #331/#333, #328 | Povezati s postojećim DAN-ovima gdje se preklapaju                        |
| Responsive i pristupačnost                   | #341; DAN-232                           | Kriteriji uz svaki ekran i završna provjera                               |

Prije prvog izvršnog koraka osvježiti sve retke. Tijekom planiranja nisu mijenjani statusi ni tuđe rezervacije.

#### 5. Redoslijed i granice isporuke

| Faza                          | Ishod                                                                                      | Preduvjeti                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| A — postojeći demo            | Isti studentski rad prolazi pisanje, trajnu sinkronizaciju, nastavnički komentar i predaju | Aktualni #711, #476 i K-4                             |
| B — svakodnevni rad           | Moji radovi, postojeći kolegiji, roster, verzije zadatka i rokovi                          | A; dodatne projekcije i ugovori B4–B9                 |
| C — upravljanje i privatnost  | Ovlašteni institucijski admin, studentov audit i verzije                                   | A/B; D-16/AAI i data-access odluke                    |
| D — dodatni prihvaćeni tokovi | Obavijesti, dorade, institucionalna pravila i izvoz                                        | Odgovarajući B/C ugovori i prihvaćeni raspored valova |
| E — pilot i operacije         | Provjerljiva spremnost, infrastruktura i zasebna ops granica                               | Postojeći M1/M10/M11 GO uvjeti                        |

Faza A je postojeći odobreni posao prije demoa. Faze B–E su prijedlog redoslijeda unutar prihvaćenog programa, uz primjenu njegovih valova; ovaj dokument ih ne prebacuje automatski u demo ili prvi pilot.

#### 6. Faza A — dovršetak postojećeg demo toka

##### A1. Jedinstveni dokument zadatka i stari lokalni nacrt

**Vlasnik:** postojeći Frontend pisac; Task DAN-89/#711. **Risk:** critical.

**Datoteke:** postojeći app/rad/page.tsx, src/components/editor/LocalDocument.tsx, CommentPanel.tsx, src/components/student/work-context-read.ts; novi work-document-plan.ts i OpenWork.* postoje u otvorenom #731, ne stvarati njihove kopije. Serverski izvor je src/server/evidence/work-document-read.ts.

**Interfaces:** koristiti postojeći `readWorkDocument(token, assignmentId, withActor): Promise<WorkDocumentRead>` i `openWork(assignmentId)`. Njihov `documentId` ide u journal, komentare, live i predaju. Ugovor #711 i D-167 određuju odvojeni slobodni nacrt.

- [ ] Provjeriti #731 na njegovu aktualnom headu i dovršiti postojeći F1a postupak.
- [ ] F1b dovršiti u zasebnom postojećem podkoraku: stari local-demo-document ponuditi kao spašenu kopiju; ručni prijenos bilježi lijepljenje.
- [ ] Provesti konkretne E2E asercije: zadatak A i B daju različite id-jeve; ista predaja i editor daju isti id; drugi korisnik ne vidi kopiju; GET stranice ne stvara rad.
- [ ] Izvesti profil UI + TRUST iz odjeljka 12, zatim predati stvarni SHA i poznate granice.

**Dokaz:** `expect(editorDocumentId).toBe(submissionDocumentId)` i `expect(documentA).not.toBe(documentB)` uz stvarne sintetičke radove. Nazivi varijabli ovdje označavaju vrijednosti opažene u E2E-u, nisu novi produkcijski API.

##### A2. Stvarni UI pozivatelj evidencije, novi uređaj i oporavak

**Vlasnici:** postojeći Frontend/Backend opsezi DAN-37/DAN-49/#476. **Risk:** critical.

**Datoteke:** src/components/editor/LocalDocument.tsx; postojeći src/lib/journal/atomic-dexie-journal.ts, src/lib/sync/drain-runner.ts, evidence-transport.ts; src/client/evidence-ingest.ts; src/domain/serverSync/bootstrap.ts. Ako ugovor dodaje EvidenceSession, upotrijebiti putanju koju je već odredio postojeći pisac.

**Interfaces:** `journal.startEvidence(documentId, opened, openedAt)`, `journal.adoptServerEvidence(...)`, `createDrainRunner(deps).step(documentId)`, `createEvidenceTransport()` i `evidenceVerifierFor(work)`. Tijela i potpise funkcija preuzeti iz aktualnog ugovora; ovaj plan ih ne mijenja.

- [ ] Završiti postojeći bootstrap: lokalni snapshot zadržava lokalni rad; uređaj bez journala dobiva provjereni server snapshot; bez oba izvora nema izmišljenog praznog dokumenta.
- [ ] Spojiti snimanje odsječaka, transport i provjeru potvrde po istom dokumentu. Uz kasni odgovor nakon novog EDIT-a ne postaviti lažni SYNCED.
- [ ] Izvesti scenarije: offline → povrat; izgubljen odgovor i retry; novi uređaj; dvije kartice; dva konkurentna uređaja; korumpiran server snapshot; istek sesije; spašena kopija kroz odjavu/prijavu.
- [ ] Predati TRUST provjere i zapisati što od recovery ugovora nije izvedeno.

**Granica:** offline ponovno pokretanje aplikacije/PWA nije dio ovog koraka. Multi-device i trajna evidencija imaju prednost pred novim offline startup mehanizmom.

##### A3. Nastavnik dolazi do stvarnog rada kroz navigaciju

**Vlasnik:** postojeći F2 u DAN-89/#711. **Risk:** najmanje standard; povećati ako se mijenja authz.

**Datoteke:** src/components/teacher/TeacherCourses.tsx, app/nastavnik/rad/[id]/page.tsx; postojeći src/server/evidence/assignment-works.ts. Detalj rute odabrati prema postojećem F2 ugovoru, a B5 kasnije proširuje puni ekran.

**Interface:** `readAssignmentWorks(sessionToken, assignmentId, withActor): Promise<AssignmentWorksRead>` vraća samo parove `studentId/documentId`. Nije izvor imena, statusa predaje ili studenata bez rada.

- [ ] Dovršiti postojeće poveznice kolegij/zadatak → rad, bez ručnog prepisivanja id-ja u adresu.
- [ ] Zadržati jednaku zabranu za tuđi i nepostojeći rad; obična poveznica nije dokaz prava.
- [ ] E2E: nastavnik otvori rad vlastitog zadatka; nastavnik drugog kolegija i drugi student dobiju neutralno odbijanje.
- [ ] UI + odgovarajući TRUST dokaz na testiranom SHA-u.

**Prikaz identiteta:** B2 projekcija ne nosi ime ni prezime. Za ovaj mali most ne izmišljati imena; puni roster zahtijeva C1 ugovor.

##### A4. Puni K-4 kroz prihvaćene površine

**Vlasnik:** postojeći QA/Frontend opseg DAN-89 i DAN-232. **Risk:** po stvarnom diffu i aktualnim iznimkama.

**Datoteke:** e2e/login/demo-flow.spec.ts; postojeći evidence-receipt.ts, assignment-work.ts i sintetički fixtureovi. Sažetak ostaje ProcessSummaryView.

- [ ] Nakon A1–A3 zamijeniti tri obvezna test.step.skip stvarnim radnjama; ne uklanjati skip oznaku bez dokaza ishoda.
- [ ] Jedan tok: nastavnik stvara zadatak → student se upisuje i potvrđuje obavijest → piše offline → dobiva provjerenu potvrdu → nastavnik otvara i komentira → student predaje → obje uloge otvaraju isti sažetak.
- [ ] Usporediti documentId, reviziju i otisak kroz iste stvarne zapise, ne samo izgled teksta.
- [ ] Izvesti negativne slučajeve i pregledati video; zapisati source SHA, testirani SHA, rezultate i broj obveznih preskočenih koraka = 0.

**Prije prihvata:** DAN-89 Done i zeleni CI ne zamjenjuju taj dokaz. Korekcija statusa pripada ovlaštenom nositelju u Linearu.

#### 7. Faza B — svakodnevni studentski i nastavnički rad

##### B1. Serverska projekcija studentskih kolegija, zadataka i radova

**Vlasnik:** Backend. **Trag:** #335, M2/M7; povezati Linear prije izvršenja. **Risk:** critical ako se uvodi/širi podatkovna granica.

**Create:** src/server/institution/student-workspace.ts i student-workspace.test.ts. **Test:** novi db/tests/090-student-workspace.sql; numeraciju provjeriti prije upisa.

**Predloženi novi interface:**

```ts
type StudentWorkspaceItem = {
  assignmentId: string;
  courseId: string;
  courseName: string;
  academicYear: string;
  title: string;
  opensAt: string;
  dueAt: string;
  currentVersion: number;
  acknowledged: boolean;
  documentId: string | null;
  serverRevision: number | null;
  submittedRevision: number | null;
  submittedAt: string | null;
  afterDeadline: boolean | null;
};
type StudentWorkspaceRead =
  { kind: "ok"; items: StudentWorkspaceItem[] } | { kind: "unauthorized" | "unavailable" };
declare function readStudentWorkspace(
  token: string | undefined,
  withActor: WithActor,
): Promise<StudentWorkspaceRead>;
```

- [ ] Testirati sintetičku studenticu s dva kolegija i radovima te drugu ustanovu: vidi samo vlastite dopuštene zadatke i predaje; zatvoreno članstvo ne otvara editor.
- [ ] Implementirati jedan RLS SELECT u withActor, s eksplicitnim provjerama uloge/aktivnog članstva po uzoru na WORK_DOCUMENT_SQL. Ako postojeća RLS prava nisu dovoljna, dodati uski RPC po modelu assignment_works, a ne širiti grantove na identity tablice.
- [ ] Razlikovati odsutan rad, odsutnu predaju i nedostupnu bazu. Ne izvoditi aktivnost iz vremena ni označavati lokalni nacrt kao potvrđen serverski rad.
- [ ] DB + UNIT provjere. Prva inačica može čitati postojeće tablice bez nove migracije; indeks ili RPC dodati tek uz pokazanu potrebu.

**Spremno kad:** vlastiti popis je stvaran, tuđi se redak ne može dobiti podmetnutim parametrom, nedostupnost baze nije prazna lista.

##### B2. Studentski ekran Moji radovi i početna po dostupnom prostoru

**Vlasnik:** Frontend. **Ovisi:** B1. **Risk:** standard; primijeniti risk floor za stvarni diff.

**Create:** app/student/page.tsx, app/student/loading.tsx, src/components/student/StudentWorkspace.tsx i StudentWorkspace.module.css. **Modify:** app/page.tsx, src/components/shell/nav.ts, src/lib/i18n/messages.hr.ts. Putanja /student je prijedlog ovog plana, nije postojeća ruta.

**Interface:** `StudentWorkspace({items}: {items: readonly StudentWorkspaceItem[]})`; server stranica poziva samo readStudentWorkspace. Odabrani assignment vodi preko /zadatak/[id] i postojeće notice provjere.

- [ ] E2E student-workspace.spec.ts: dva kolegija, dva zadatka, nova verzija obavijesti, predani rad, prazan dopušteni popis i nedostupna baza daju različita ispravna stanja.
- [ ] Prikazati naslov, kolegij, akademsku godinu, rok i dokazano stanje rada; dodati pretragu po naslovu i filter po godini. Pretraga nikad ne proširuje serverski skup podataka.
- [ ] U navigaciji dodati Moji radovi, a Slobodan nacrt i Upis ostaviti zasebnima. Početna vodi u dopušteni prostor; promjena navigacije ne dodjeljuje ulogu.
- [ ] UI provjera na desktopu i telefonu; povratak iz editora čuva točan zadatak.

**Arhiva:** prošla akademska godina je filter, ne automatsko brisanje, zatvaranje ili read-only. Prava arhiva zahtijeva dogovoren lifecycle kolegija u M2.

##### B3. Zadatak u postojećem kolegiju

**Vlasnik:** Frontend; Backend samo ako ugovor pokaže nedostatak postojećeg čitanja. **Trag:** dopuniti DAN-35/#337. **Ovisi:** osnovni readTeacherCourses. **Risk:** standard.

**Create:** app/nastavnik/kolegiji/[courseId]/zadatak/novi/page.tsx, src/components/teacher/AssignmentForm.tsx i ciljane testove. **Modify:** TeacherSetup.tsx i TeacherCourses.tsx. **Reuse:** src/components/teacher/assignment-create.ts, postojeći POST /api/institution/courses/[courseId]/assignments i createAssignment.

**Interface:** `AssignmentForm({courseId, coursePolicy}: {courseId: string; coursePolicy: CoursePolicy})`. U kodu ponovno koristiti postojeći tip CoursePolicy, validaciju assignmentBody i idempotency key ugovor.

- [ ] Test naziva existing course creates second assignment without creating another course: poslije uspjeha jedan kolegij ima dva zadatka; createCourse nije pozvan.
- [ ] Izdvojiti postojeća polja zadatka iz TeacherSetup u AssignmentForm bez promjene njihove semantike. Page utvrđuje da courseId pripada nastavnikovom dopuštenom popisu.
- [ ] Isti obrazac koristiti nakon stvaranja novog kolegija i iz detalja postojećeg; nakon uspjeha ponuditi Otvori zadatak / Natrag na kolegij.
- [ ] Provjeriti retry istog zahtjeva, izgubljen odgovor, odbijen kolegij i očuvanje upisanih polja nakon greške. UNIT + UI.

##### B4. Dosljedna predaja i trajno vezanje predane revizije

**Vlasnici:** Backend i postojeći Frontend predaje u odvojenim PR-ovima. **Trag:** DAN-289, DAN-291, DAN-87; ne otvarati drugi submission mehanizam. **Risk:** critical.

**Datoteke:** postojeći src/server/evidence/submission.ts, submission-record.ts, src/components/student/Submission.tsx i SubmissionView.ts, src/lib/journal/atomic-dexie-journal.ts; nove migracije s bazama imena close_submitted_package i stable_submission_receipt samo ako to preostaje u aktualnom DAN-u. Dovršiti unutar postojećih testova predaje i db/tests/061-submission.sql, db/tests/062-submission-record.sql i db/tests/063-submission-receipt-issuance.sql.

**Interfaces:** sačuvati postojeći SubmissionOutcome i SignedSubmissionReceiptV1; kod slijedi stvarni request_submission → rekonstrukcija → record_submission. Predaja uvijek imenuje prikazanu serversku reviziju.

- [ ] Prvo reproducirati rizik: poslužitelj ima reviziju N, lokalno je noviji nepotvrđeni tekst; otvoriti stranicu predaje. Zabilježiti stvarno ponašanje prije proglašenja buga.
- [ ] Dodati čitanje lokalnog stanja za isti scope/documentId. Predloženi UI ugovor: kod potvrđenih pending promjena primarna radnja vraća na sinkronizaciju; svjestan izbor stare prikazane revizije mora biti zasebno i jasno potvrđen. Ako lokalno stanje nije dostupno, prikazati unknown i ne tvrditi da su svi uređaji sinkronizirani. Ovaj izbor potvrditi u postojećem ugovoru predaje prije koda.
- [ ] Backendovim atomskim korakom završiti prihvaćeni DAN-289 ugovor zatvaranja paketa. Sačuvati predani revision/hash i mogućnost čitanja baš te verzije; eventualni novi krug rada zahtijeva zaseban ugovor otvaranja, bez promjene već predane revizije.
- [ ] DAN-291: prvi uspješan rezultat potvrde pohraniti i ponovno vratiti iste bajtove, vrijeme i identifikatore. Iskoristiti već postojeću submission_receipt_issuance migraciju i provjeriti što točno još nedostaje.
- [ ] Testirati gubitak odgovora, dupli klik, dvije kartice, lokalni edit tijekom učitavanja predaje, mismatch, promjenu baze nakon predaje i ponovno čitanje potvrde. DB + UNIT + TRUST + UI.

**Podjela:** lokalni guard, zatvaranje paketa/čitanje predane verzije i stabilna potvrda tri su neovisno pregledljiva PR-a u postojećim zadacima. U demo ulazi samo dio koji pripada važećem prihvatnom ugovoru; ostalo se dovršava prije stvarnog pilota.

##### B5. Puna serverska projekcija nastavničkog popisa radova i predaja

**Vlasnik:** Backend. **Trag:** DAN-290 i čitanje predane verzije iz DAN-289. **Ovisi:** B4 za immutable submission detalj; C1 prije proširenja identiteta. **Risk:** critical.

**Create:** src/server/institution/assignment-roster.ts, assignment-roster.test.ts, nova migracija assignment_submissions i pgTAP datoteka assignment-submissions.sql. **Reuse:** institution.course_member, evidence.submission, app.assignment_works.

**Predloženi interface:**

```ts
type AssignmentRosterItem = {
  studentId: string;
  displayLabel: string | null;
  documentId: string | null;
  submissionId: string | null;
  submittedRevision: number | null;
  submittedAt: string | null;
  afterDeadline: boolean | null;
};
type RosterCursor = { sortKey: string; studentId: string };
type AssignmentRosterRead =
  | { kind: "ok"; items: AssignmentRosterItem[]; nextCursor: RosterCursor | null }
  | { kind: "unauthorized" | "not_found" | "unavailable" };
declare function readAssignmentRoster(
  token: string | undefined,
  assignmentId: string,
  page: { limit: number; cursor: RosterCursor | null },
  withActor: WithActor,
): Promise<AssignmentRosterRead>;
```

- [ ] pgTAP fixture: četiri upisana studenta — bez rada, rad bez predaje, pravodobna predaja i predaja nakon roka. Rezultat ovlaštenog nastavnika ima sva četiri; nema pristupa nastavnika drugog kolegija ni druge ustanove.
- [ ] Implementirati predloženi RPC app.assignment_submissions(p_assignment_id uuid, p_limit integer, p_after_sort_key text, p_after_student_id uuid). Zadani limit je 50, dopušteno 1–100; server validira cursor. Cross-schema čitanje slijedi uske helper-e i vlasništvo iz assignment_works, ne globalni SELECT grant.
- [ ] Vrijeme i kašnjenje uzimati iz pohranjene predaje. Polje displayLabel ostaje null dok C1 ugovor ne osigura dopušten izvor; ne koristiti DEMO_FAST_PATH.
- [ ] Ugovor C1 mora definirati stabilni sortKey prema dopuštenom prezimenu/oznaci i provjerenoj DB kolaciji. Keyset cursor zatim koristi (sortKey, studentId); za neprovjereno imenovanje ne prikazivati tvrdnju o poretku po prezimenu. Prvi mali F2 iz A3 ne čeka ovaj puni roster.
- [ ] Izvesti DB + UNIT, uključujući opoziv uloge tijekom postojeće sesije.

**Granica:** popis svih trenutno upisanih i povijesni prikaz uklonjenih studenata odvojeni su upiti i prava. Ovdje se ne daje administratoru pristup sadržaju.

##### B6. Nastavnički detalj zadatka i pregled predane verzije

**Vlasnik:** Frontend. **Trag:** #327/#338 + DAN-290/DAN-289. **Ovisi:** B5, A3. **Risk:** standard za prikaz, critical kad se dira trust granica.

**Create:** app/nastavnik/zadatak/[assignmentId]/page.tsx, loading.tsx; src/components/teacher/AssignmentRoster.tsx i CSS. **Modify:** TeacherCourses.tsx; FastPath.tsx samo prema odobrenom ugovoru stvarne projekcije.

**Interface:** `AssignmentRoster({items}: {items: readonly AssignmentRosterItem[]})`. Server stranica validira cursor iz searchParams i zove readAssignmentRoster s page argumentom; paginacijske poveznice čuvaju assignmentId. Link na live rad i link na predanu reviziju dvije su jasno označene radnje.

- [ ] E2E assignment-roster.spec.ts: svi upisani su prikazani, rad bez predaje nije Predano, a nakon nove promjene dokumenta predana verzija i dalje je ista.
- [ ] Dodati navigaciju kolegij → zadatak → studentov rad; prikazati stanja tekstom bez rangiranja po količini rada ili evidenciji.
- [ ] Ponuditi Otvori trenutačni rad i Otvori predanu verziju samo kad za njih postoje ovlašteni serverski podaci.
- [ ] Provjeriti duga sintetička imena/naslove, prazne retke, tipkovnicu, uski ekran, paginaciju i neutralan odgovor na tuđi assignmentId. UNIT + UI.

**Ne koristiti:** stariji #327 prijedlog prosječne dovršenosti ili dokaznih nedostataka bez provjere PRODUCT pravila i D-105. Tijek rada i cjelovitost evidencije ostaju različite informacije.

##### B7. HTTP granica za novu verziju zadatka

**Vlasnik:** Backend. **Trag:** DAN-292, jedan postojeći RPC po koraku. **Risk:** critical.

**Create:** app/api/institution/assignments/[assignmentId]/versions/route.ts, src/server/institution/assignment-version-route.ts i test. **Reuse:** institution.publish_assignment_version, checkMutationRequest, readBodyWithLimit i postojeći zatvoreni parser polja zadatka.

**Predloženi HTTP ugovor:** POST s expectedVersion i istim sadržajnim poljima koja podržava aktualni RPC/AssignmentBody. Uspjeh vraća assignmentId i novu versionNo; zastarjela expectedVersion daje 409 bez upisa; neovlašten resurs neutralan 404/403 prema ugovoru ustanove.

- [ ] Testirati dva zahtjeva s istom expectedVersion: najviše jedan stvara novu verziju; drugi ne prepisuje rezultat.
- [ ] Serverski pozvati postojeći RPC u withActor. Pokušaj širenja već potvrđenih pravila mora biti odbijen; nema prepisivanja starih assignment_version ili notice_acknowledgment redaka.
- [ ] Provjeriti postojeći word_min/word_max potpis aktualnog RPC-a; ne koristiti stari potpis iz prve migracije.
- [ ] DB + UNIT + integration: novi student potvrđuje novu verziju, stari acknowledgment ostaje povijesni, evidence za novu verziju traži odgovarajuću potvrdu.

##### B8. Uređivanje zadatka s pregledom posljedica promjene

**Vlasnik:** Frontend. **Trag:** #337 uz DAN-292; povezati Linear opseg. **Ovisi:** B3, B7. **Risk:** standard/critical prema semantici promjene.

**Create:** app/nastavnik/zadatak/[assignmentId]/uredi/page.tsx, src/components/teacher/AssignmentVersionPreview.tsx. **Modify:** AssignmentForm.tsx za početne vrijednosti i postojeću verziju; src/components/student/AssignmentNotice.tsx samo ako nedostaje tekst nove potvrde.

**Predloženi interface:** `AssignmentForm` dobiva diskriminiranu konfiguraciju `mode: "create" | "newVersion"`; u newVersion slučaju obvezni su assignmentId i expectedVersion. Ne dodavati režim kojim klijent sam određuje prava.

- [ ] Test: nastavnik vidi staru i predloženu vrijednost; poruka kaže da se objavljuje nova verzija; odbijena promjena čuva upisana polja.
- [ ] Onemogućiti prikaz radnje koja bi širila potvrđena pravila, uz server kao konačnu provjeru. Prikazati 409 i radnju Učitaj aktualnu verziju.
- [ ] Studentu pri sljedećem otvaranju prikazati novu obavijest kroz postojeći gate; bez automatskog označavanja kao pročitano.
- [ ] UNIT + UI: dva nastavnikova prozora, stara forma, novi acknowledgment i očuvanje već izdanih potvrda.

##### B9. Produljenje roka i upravljanje upisom kao odvojene radnje

**Vlasnici:** Backend pa Frontend. **Trag:** M7 produljenje; DAN-292 za revoke koda/uklanjanje/povratak. **Risk:** critical za nove ovlasti i podatke.

**Novi model, prijedlog za ugovor:** institution.deadline_extension(assignment_id, student_id, extension_no, due_at, reason, granted_by, created_at), nepromjenjiva povijest; razlog vide samo taj student i nastavnik zadatka. Očekivana verzija produženja štiti paralelne upise. Stvarno ime migracije dodjeljuje dbmate u trenutku izvršenja.

**Predložene datoteke:** src/server/institution/deadline-extension.ts; app/api/institution/assignments/[assignmentId]/extensions/route.ts; src/components/teacher/DeadlineExtensionDialog.tsx. Postojeći request_submission i B1/B5 projekcije trebaju isti izračun efektivnog roka.

- [ ] Definirati i testirati effectiveDueAt kao kasniji od aktualnog općeg roka i dopuštenog individualnog produženja; vrijeme prihvata predaje ostaje requested_at iz sata baze.
- [ ] Dodati RLS/RPC za nastavnika konkretnog zadatka. Produženje se upisuje kao nova odluka; retroaktivno mijenjanje već evidentiranog afterDeadline ishoda nije dopušteno.
- [ ] UI prikazuje kome, do kada i s kojim razlogom se produžuje, uz pregled prije potvrde. Drugi student ne vidi razlog niti podatke.
- [ ] Zasebni mali podkoraci DAN-292 izlažu postojeće revoke_enrollment_code, remove_student i allow_student_return. Dijalog za zamjenu koda jasno kaže da se prethodni kod mijenja; plaintext se prikazuje samo jednom.
- [ ] DB + UI: rub točno na roku, dva UTC vremena u ponovljenom jesenskom satu Europe/Zagreb, ponavljanje zahtjeva, dva nastavnika, opoziv prava i zabranjeni tuđi student.

**Podjela:** deadline backend, deadline UI i upravljanje članstvom/kodom odvojeni su PR-ovi. Odobreni rok čuvanja nije rok predaje i ne koristi ovaj model.

#### 8. Faza C — institucijska administracija i privatnost

##### C1. Ugovor za prikaz identiteta i potvrdu nastavničke uloge

**Vlasnici:** vlasnik/AAI nositelj i Backend; ovo je ugovor prije skupih promjena koda. **Trag:** DAN-196/DAN-198, D-16, #333.

**Dokaz iz koda:** LoginIdentity u src/server/auth/claims.ts trenutačno ima subject, uniqueId i homeOrg. identity.user_account nema ime/prezime ni pohranjenu pripadnost djelatnicima. confirm_teacher_role provjerava ustanovu i administratorsku ovlast, ali ne provjerava atribut djelatnik.

- [ ] U postojećem AAI zadatku potvrditi koji provjereni izvor daje minimalnu oznaku osobe za studentski roster i popis kandidata; odvojiti identitet od prikaznog imena.
- [ ] Potvrditi D-16 i dokaz podobnosti za nastavničku ulogu: koji podatak se čita, gdje se pohranjuje, koliko je svjež i kako se opoziva.
- [ ] Odrediti da AAI pripadnost samo stvara podobnost; stvarni grant i dalje radi ovlašteni administrator.
- [ ] Tek nakon prihvata ugovora proširiti claims/open_session model i uski identity read. Testirati izmijenjen/neprovjeren atribut, drugu ustanovu, nedostupnost izvora i odsutno prikazno ime.

**Izlaz:** prihvaćen ugovor u postojećem zadatku i repou, s popisom stvarnih atributa i rubnih slučajeva. Ovaj dokument ne izmišlja nazive AAI atributa za ime/prezime niti proglašava D-16 prihvaćenim.

##### C2. Uske administratorske projekcije, grantovi i audit promjena

**Vlasnik:** Backend. **Trag:** DAN-292 i #333/#331. **Ovisi:** C1 za stvarne nastavnike; sintetički testovi mogu se pripremiti prije toga. **Risk:** critical.

**Create:** src/server/institution/admin-people.ts, teacher-role-route.ts; app/api/institution/teacher-grants/route.ts i teacher-revocations/route.ts. Nova migracija institution_admin_people dodaje ograničeno čitanje; audit_admin_action dodaje administrativni trag ako aktualni audit modul to još nema.

**Predloženi interfaces:**

```ts
type TeacherCandidate = {
  id: string;
  displayLabel: string | null;
  eligibility: "verified" | "unknown";
  teacherRole: "confirmed" | "unconfirmed";
};
declare function readTeacherCandidates(
  token: string | undefined,
  withActor: WithActor,
): Promise<
  | { kind: "ok"; people: TeacherCandidate[] }
  | { kind: "unauthorized" | "not_found" | "unavailable" }
>;
```

HTTP POST grant prima candidateId; opoziv prima teacherId. Akter i ustanova uvijek se izvode iz sesije. Rezultat ne vraća podatke druge ustanove.

- [ ] pgTAP: admin A vidi dopuštene kandidate A i potvrđuje drugu podobnu osobu A; ne potvrđuje sebe, osobu B ni osobu bez potrebnog verificiranog uvjeta.
- [ ] Omotati postojeće institution.confirm_teacher_role i revoke_teacher_role uz checkMutationRequest i zatvorene greške. Retry iste potvrde ne stvara dvostruku aktivnu ulogu.
- [ ] U istoj transakciji zapisati admin radnju s akterom, ustanovom, vrstom, ciljanim resursom, vremenom i ishodom. Dnevnik otvaranja rada ne pretvarati u opći admin log; koristiti zasebnu tablicu ako shema to zahtijeva.
- [ ] Testirati aktivnu sesiju opozvanog nastavnika: sljedeće čitanje rada je odbijeno; prethodna sesija ne održava stari grant.
- [ ] DB + UNIT + integration. Kandidatski popis ne smije postati izvoz svih studentskih identiteta.

##### C3. Minimalni fakultetski administratorski prostor i navigacija

**Vlasnik:** Frontend. **Trag:** #331/#333, povezan s DAN-292. **Ovisi:** C2. **Risk:** standard/critical prema dodiru granice ovlasti.

**Create:** app/ustanova/page.tsx, app/ustanova/korisnici/page.tsx, src/components/institution/TeacherRoles.tsx i pripadajući CSS/testovi. **Modify:** AppShell, nav.ts i shell-role.ts; katalog poruka.

**Predloženi interface:** `readShellCapabilities(token, withActor)` vraća serverom utvrđen popis dostupnih područja student/teacher/institutionAdmin. Aktivno područje je ono trenutne rute; capability nije dokaz pristupa pojedinom resursu.

- [ ] Testirati korisnika s nastavničkom i admin ulogom: može promijeniti područje, ali API provjerava svaku radnju. Podmetnut query/cookie role=admin nema učinka.
- [ ] Implementirati popis podobnih nastavnika, stanje čeka potvrdu/potvrđen i dijalog potvrde/opoziva. Radnju prikazati tek uz provjerene podatke i ponoviti provjeru na serveru.
- [ ] Početni admin pregled prikazuje samo ovlaštene metapodatke i vrijeme osvježavanja. Ne dodavati otvaranje studentskih radova.
- [ ] UNIT + UI: prazan popis, unknown podobnost, neuspjeli upis, ponovljeni klik, promjena računa u drugoj kartici i druga ustanova.

**Prvi admin:** i dalje se postavlja postojećim odobrenim provisioning postupkom na zahtjev ustanove; ovaj ekran ne daje sam sebi admin prava.

##### C4. Studentov dnevnik pristupa — stvarni read i ekran

**Vlasnici:** Backend pa Frontend. **Trag:** DAN-294, uz DAN-228 kao dokaz postojećeg zapisivanja. **Risk:** critical za novi podatkovni ugovor; ne preuzimati nižu oznaku iz naslova zadatka bez provjere Engineering Systema.

**Create:** src/server/audit/work-access.ts, app/api/documents/[documentId]/access/route.ts; src/components/student/WorkAccessLog.tsx. Nova migracija read_work_access_log dodaje samo ovlašteno čitanje.

**Predloženi DTO:** `{accessedAt: string; actorRole: string; actorLabel: string | null; action: string}`. Vremenska preciznost i imenovanje otvaratelja slijede prihvaćeni ugovor, ne sirovi DB timestamp.

- [ ] Prije koda razriješiti postojeće DAN-294 pitanje što je otvaranje rada, uključujući čitanje komentara. To mijenja značenje zapisa, pa ne izmišljati mjeru u UI-ju.
- [ ] RPC dopušta vlasniku dokumenta samo njegovu projekciju; nastavnik i drugi student kroz ovu rutu nemaju pravo.
- [ ] UI u radu nudi Tko je pristupio radu, s praznim stanjem i nedostupnošću. Nema vremenskog ritma, bodovanja ili izlaganja tuđih dokumenata.
- [ ] pgTAP/UNIT/E2E: jedan nastavnički pristup se pojavi vlasniku; drugi student ne vidi ni redak ni identitet; polling ne proizvodi izmišljene nove ljudske posjete.

##### C5. Čitanje verzija rada i studentski vremeplov

**Vlasnici:** Backend pa Frontend. **Trag:** DAN-293/S-02; raspored valova iz PROGRAM. **Ovisi:** A2 i ugovor dopuštenih verzija; B4 za predanu verziju. **Risk:** critical.

**Create:** src/server/evidence/checkpoint-read.ts, app/api/documents/[documentId]/versions/[revision]/route.ts, src/components/student/WorkVersions.tsx. **Reuse:** evidence.document_checkpoint i verifyDocumentSnapshot.

- [ ] Implementirati predloženi app.read_document_checkpoint(documentId, revision) uz postojeći DAN-293 ugovor i ponovnu provjeru hasha.
- [ ] Prvi UI prikazuje vlastite imenovane/poslane/predane verzije; povrat verzije nudi eksplicitnu kopiju/novu izmjenu, bez prepisivanja povijesti ili tihe predaje.
- [ ] Odvojiti studentsku vlastitu povijest od nastavničkog prava na dopuštene verzije. Checkpoint tablica ne daje automatski pravo na sve međusnimke, a vremeplov nije UI reprodukcije znak po znak.
- [ ] DB + UNIT + UI: korumpirani checkpoint se ne prikazuje kao ispravan, tuđa revizija je nedostupna, vraćanje kopije ne mijenja postojeću potvrdu predaje.

#### 9. Faza D — obavijesti, dorade, pravila i izvoz

##### D1. Obavijesti unutar aplikacije

**Vlasnici:** Backend pa Frontend. **Trag:** N-01/N-02 u FEATURES/PROGRAM; povezati postojeći ili predložiti novi uski Linear zadatak. **Ovisi:** stabilni B/C događaji. **Risk:** critical za nove tablice i ovlasti.

**Predloženi model:** institution.notification s id, institution_id, recipient_id, event_key, kind, target_id, created_at i read_at; jedinstvenost po recipient_id/event_key. Nema sadržaja rada niti proizvoljnih HTML poruka.

**Create:** src/server/notifications/notifications.ts; app/obavijesti/page.tsx, app/api/notifications/read/route.ts i src/components/notifications/NotificationList.tsx. Nova migracija user_notifications; RLS čitanja/označavanja samo za primatelja.

**Interfaces:** `readNotifications(token, cursor, withActor)` vraća ograničen popis metapodataka; `markNotificationRead(token, notificationId, withActor)` idempotentno označava vlastitu obavijest. Vrste prvog reza: objavljen komentar, nova verzija zadatka i zabilježena predaja; dorade dodaje D2.

- [ ] Testirati da retry iste domenske radnje stvara jednu obavijest po primatelju; rollback ne ostavlja lažnu obavijest.
- [ ] Događaj nastaje uz stvarnu mutaciju u istoj DB transakciji ili putem prihvaćenog transakcijskog outboxa. Preglednik ne može proizvoljno slati obavijesti drugim osobama.
- [ ] Inbox i broj nepročitanog čitaju stvarni status; link ponovno provjerava pravo ciljanog resursa. Opoziv pristupa ne smije ostaviti čitljiv sadržaj kroz staru poveznicu.
- [ ] DB + UNIT + UI: drugi primatelj, dupli događaj, prazan inbox, nedostupnost i označi pročitano bez proširenja prava.

**N-01/N-02 drugi rez:** rokovi, postavke i dnevni sažetak e-poštom koriste postojeći predviđeni worker/poslove nakon B-9. Produljenje roka mijenja budući raspored podsjetnika. E-pošta čeka odabran i odobren transport iz B0.1; lokalno Mailpit. Provider, ključevi i naplata ne uvode se ovim planom.

##### D2. Trajni zahtjevi za doradu i odgovor studenta

**Vlasnici:** Backend pa Frontend. **Trag:** #338/D-45/M6; pronaći/povezati Linear prije rada. **Ovisi:** A1/A2 i dozvoljeno sidrenje komentara; D1 za obavijesti. **Risk:** critical.

**Reuse:** src/domain/collaboration/revision-request.ts i TextAnchor. Sačuvati stanja OPEN, STUDENT_RESPONDED, SHARED_FOR_REVIEW, ACCEPTED_FOR_REVISION, NEEDS_CLARIFICATION i REREVIEW_REQUIRED.

**Create:** src/server/collaboration/revision-requests.ts; app/api/revision-requests/[action]/route.ts; src/components/editor/RevisionRequests.tsx i nastavničku komponentu. Migracija revision_requests dodaje izvorni zahtjev, odgovor i audit promjena s verzijom stanja.

- [ ] Povezati postojeće createRevisionRequest, submitStudentResponse, shareResponseForReview, acceptForRevision i requestClarification sa serverskim pravima i očekivanom stateVersion.
- [ ] Autor zahtjeva dolazi iz sesije nastavnika toga rada; odgovor daje samo student vlasnik. Izvorni requestedRevision i sidro ostaju sačuvani.
- [ ] Testirati pogrešnu tranziciju, odgovor za drugi requestId, prihvat bez odgovora i dva paralelna odgovora. Jedna tranzicija uspijeva, druga dobiva konflikt bez gubitka teksta.
- [ ] UI prikazuje zahtjev, odgovor, povezanu reviziju i iduću dopuštenu radnju. Prihvaćanje dorade nije ocjena autorstva ni konačna predaja.
- [ ] DB + UNIT + UI. S-UV1/conditions ostaje u postojećem prihvaćenom režimu/flagu; ovaj plan ga ne uključuje automatski.

##### D3. Institucionalna pravila i njihove verzije

**Vlasnici:** Backend i Frontend nakon prihvaćenog ugovora. **Trag:** #328, D-52/D-117; povezati s M2/M10. **Ovisi:** C2/C3 i prihvaćeni model pravila. **Risk:** critical.

**Prvi ugovor treba točno odrediti:** što smije mijenjati ustanova, što kolegij, što zadatak; kako se pravila sužavaju; tko smije objaviti; koja verzija se primjenjuje na novi zadatak; gdje se sprema nepromjenjivi snapshot.

**Predložene putanje:** src/server/institution/policy-versions.ts, app/ustanova/pravila/page.tsx i src/components/institution/PolicyVersionEditor.tsx. Novi institution.policy_version s expectedVersion/CAS; assignment_version referencira odabranu verziju/snapshot bez retroaktivne izmjene starih potvrda.

- [ ] Najprije prihvatiti navedeni ugovor i migracijski postupak za postojeće legacy zadatke. Nullable polje bez objašnjenja nije dokaz primijenjene politike.
- [ ] Uvesti nacrt → pregled posljedica → objavljena nepromjenjiva verzija, s uskom administratorskom ovlasti i auditom.
- [ ] Prikazati efektivna pravila kolegija/zadatka i podrijetlo verzije. Pravila oblika iz Lekte prikazivati samo uz odobreni paket i njegovu verziju.
- [ ] Test: policy v2 ne mijenja zadatak vezan uz v1; kolizija expectedVersion daje 409; profil potvrđenog zadatka se ne proširuje; druga ustanova ne može objaviti.
- [ ] DB + UNIT + UI. Rokovi čuvanja u ovom editoru postaju aktivni tek uz odobrene M10 vrijednosti i stvarni retention postupak DAN-297.

##### D4. Izvoz rada, potvrde i evidencije

**Vlasnici:** Backend/Platforma za generiranje i Frontend za zahtjev/status. **Trag:** M7/M10, R-05/R-06, #329 i F-04; povezati prije rada. **Ovisi:** B4, dopuštene projekcije i eventualno B-9 worker. **Risk:** critical.

**Predložene putanje:** src/server/exports/request-export.ts, export-worker.ts; app/api/exports/route.ts; app/api/exports/[exportId]/route.ts; src/components/student/ExportRequest.tsx. Posao koristi postojeći planirani worker, bez trećeg servisa. Prije koda u postojećem M10 ugovoru zaključiti format/veličinu paketa, pravo izvoza, rok preuzimanja i vlasništvo DB granta. Predloženi exports.export_job čuva recipient/ustanovu, opseg/reviziju, idempotency key, status, server vrijeme, manifest hash i referencu privatnog artefakta; ne sadrži tekst u statusnom payloadu.

- [ ] Definirati verzionirani manifest paketa: dokument/revizija, potvrda, dopuštena evidencija i hashovi. Izvoz ne sadrži privatne mentorove zapise, nedopuštenu međupovijest ili tuđe podatke.
- [ ] Student iz sesije traži vlastiti izvoz; worker ponovno provjerava scope; preuzimanje traži važeću ovlast i nije javno predvidiva poveznica.
- [ ] Potvrda za referadu/PDF i Merlin paket koriste iste pohranjene vrijednosti predaje. Ne generirati novo vrijeme ili novi sadržaj potvrde pri svakom preuzimanju.
- [ ] UI razlikuje queued/running/ready/failed/expired; neuspjeh je ponovljiv bez novog poslovnog izvoza. Privremeni lokalni izvoz teksta za oporavak ostaje zasebna postojeća radnja.
- [ ] Integration + DB + UI: student B ne preuzima A; opoziv/istek linka; timeout generiranja; retry; bajtovi potvrde isti kao iz B4.
- [ ] F-04 i bivši student bez AAI računa idu kroz dokumentirani institucijski zahtjev i poseban uski grant; osnovna admin uloga ne dobiva Export all sadržaj.

#### 10. Faza E — kvaliteta svakog ekrana i operativni završetak

##### E1. Stanja sučelja, responsive i pristupačnost kroz svaki rez

**Vlasnici:** Frontend + neovisni QA prema aktualnom ugovoru. **Trag:** #341/#732, DAN-232 i DAN-234. **Izvodi se uz A–D, ne tek na kraju.**

**Datoteke:** postojeći AppShell, WorkspaceShell, CSS moduli, messages.hr.ts, e2e/accessibility.spec.ts i e2e/screenshots.spec.ts; novi ekrani dobiju odgovarajuće retke/specove.

- [ ] Za svaki novi ekran napisati konkretne slučajeve iz matrice u odjeljku 11, uključujući razlikovanje greške izvora od praznog dopuštenog rezultata.
- [ ] Zadržati postojeće v3 tokene. U pregledanom CSS-u radni prostor prelazi na dvije kolone pri 1250 px i jednu pri 1050 px; bočna navigacija prelazi u drawer ispod 800 px. Komentare/prototipove s povijesnim 1240/1000 ne uzimati kao aktualni runtime ugovor.
- [ ] Provjeriti 1440, 1024, 800 i 390 px te granice 1250/1251, 1050/1051 i 799/800 kroz test rasporeda. Osigurati najmanje 12 px UI teksta, 13 px na telefonu i postojeće ciljeve klika 32 px u gustim trakama/44 px drugdje.
- [ ] Provesti axe i stvarni tok tipkovnicom: otvaranje, fokus dijaloga, Escape, povrat fokusa, slanje forme i poruka ishoda. Prije pilota zapisati ručnu provjeru editora i predaje čitačem zaslona.
- [ ] Snimke služe pregledu stvarnog ekrana; postojeći screenshots spec ne proglašavati automatskom usporedbom s referentnom slikom.
- [ ] Nakon aktualizacije protokola DAN-234 provesti postojeći UX uvjet s najmanje 5 studenata i 5 nastavnika koji nisu gradili proizvod. Ne koristiti zastarjeli dio UX-EVAL koji proturječi prihvaćenom live prikazu.

**Već riješeno:** hrvatske error/not-found stranice #740 i tekst pragova #741 na bazi ovog plana. #742, #750 i #751 ostaju pod svojim aktualnim provjerama i rezervacijama.

##### E2. Tvoj operaterski prostor nakon prihvaćene auth granice

**Vlasnici:** vlasnik/Platforma/Backend za ADR, zatim odvojeni Backend i Frontend zadaci. **Trag:** uloga operatera u PRODUCT; DAN-299 za operativne izvore. Zaseban razrađen Linear zadatak za portal nije nađen. **Risk:** critical.

**Predloženi oblik:** zasebno zaštićena grupa ruta u postojećem Next.js procesu, npr. app/operacije/_, src/server/operations/_ i src/components/operations/*. Konačna ruta i session granica prihvaćaju se u ADR-u prije koda.

- [ ] ADR mora zaključiti identitet operatera, prijavu/MFA, odvojenu privilegiranu sesiju, opoziv, audit, dozvoljene projekcije i iznimni pristup podrške. Poddomena sama nije sigurnosna granica.
- [ ] Nakon toga definirati read-only prvi rez: ustanove po operativnom statusu, zdravlje servisa, posljednji potvrđeni restore, odgođeni poslovi i incidenti. Svako polje ima asOf i healthy/degraded/down/unknown/not_configured.
- [ ] Koristiti izvore DAN-299 i DAN-298; podatak iz konfiguracije ne prikazivati kao potvrđenu izvršenu provjeru.
- [ ] Testirati lažni institutionId, običnu studentsku/nastavničku/admin sesiju, isteklu ops sesiju i izostanak telemetry podataka. Nema studentskih tekstova, globalnog canReadAnyDocument niti neposrednog superuser SQL-a iz weba.
- [ ] Kasniji onboarding ustanove, poslovni ugovori i podrška dodaju se samo uz odobrene radnje i potrebne podatke. Naplata ili novi payment provider nisu preduvjet početnog portala.

**Granica točnosti plana:** dok ADR nije prihvaćen, ne daje se izmišljeni gotov OIDC provider, tablica operatora, cookie ili superuser RPC. Gore je precizan redoslijed ugovora i prvog reza, a ne odobrena nova sigurnosna arhitektura.

##### E3. Stvarni pilot, infrastruktura i podaci

**Vlasnik:** postojeći Platforma/AAI/owner zadaci. **Trag:** DAN-295–DAN-299, DAN-196/DAN-198, M10/M11. **Ovisi:** odabrani scope pilota, računi/odobrenja i izvršivi sintetički staging.

- [ ] Završiti postojeći produkcijski potpisnik, health/readiness i operativne izvore; frontend prikazuje stvarni status.
- [ ] Provesti restore baze i bucketa; zapisati stvarni rezultat i dogovorene RPO/RTO. Datum backupa nije datum uspješnog restorea.
- [ ] Primijeniti potvrđene rokove čuvanja/izvoz/hold i provjeriti njihovu izvedbu; UI sam ne briše studentske podatke.
- [ ] Izvesti prihvatni tok na odobrenom stagingu s odgovarajućim vrstama resursa i stvarnim AAI Lab ugovorom, po postojećim pravilima.
- [ ] Uz tehnički prihvat prikupiti postojeće institucionalne, podatkovne i operativne GO dokaze iz PROGRAM. Demo GO, pilot GO i produkcijski deploy ostaju različiti zapisi.

#### 11. Zajednička matrica stanja — prihvatni kriteriji u postojećim zadacima

Ova tablica ide u kriterije zadataka/PR-ova gdje je primjenjiva; ne uvodi novi statusni registar ili novu automatiziranu provjeru.

| Stanje               | Primjer                                   | UI ishod                                                           |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| loading              | Čeka se roster                            | Vidljiva poruka učitavanja, bez lažne nule                         |
| empty                | Ovlašteni student nema zadatke            | Objašnjenje i Upis u kolegij                                       |
| unauthorized/expired | Sesija istekla                            | Postojeća AAI prijava; čuvanje lokalnog rada prema ugovoru         |
| denied/not_found     | Tuđi ili nepostojeći rad                  | Neutralna poruka bez identiteta i sadržaja                         |
| pending_role         | Uloga još nije potvrđena                  | Vlastiti status i kontakt/postupak potvrde nakon C1/C2             |
| offline              | Trenutno nema mreže                       | Samo stvarno dostupne lokalne radnje, jasna granica server potvrde |
| conflict             | Drugi uređaj ili novija verzija zadatka   | Eksplicitni recovery/reload; nema tihog overwritea                 |
| unknown              | Lokalni journal/health feed nije dostupan | Ne tvrditi da je sve poslano ili zdravo                            |
| unavailable/error    | Baza ili servis nedostupan                | Poruka i siguran retry; ne prazna lista                            |
| success              | Objavljena verzija/predaja                | Potvrđeni serverski rezultat i identifikator/verzija               |
| stale/changed        | Na serveru postoji novija verzija         | Prikaz razlike i nova dozvoljena radnja                            |

Server odbijanje ne prevoditi u uspjeh. Vizualno skriven gumb ne zamjenjuje server provjeru.

#### 12. Provjere i izvršenje prema aktualnom kodu

##### 12.1 Profili koje koraci gore koriste

**UNIT — za promijenjene servise, parsere i domenski automat**

```bash
pnpm lint
pnpm typecheck
pnpm exec vitest run --project unit src/server/institution/student-workspace.test.ts
```

Posljednji argument zamjenjuje se točnom testnom datotekom navedenom u zadatku. Očekivanje: svaki konkretni novi test prolazi; privremena mutacija relevantne zaštite mora srušiti odgovarajući negativni test.

**DB — samo izolirani sintetički stack namijenjen zadatku**

```bash
pnpm stack:up
pnpm db:migrate
pnpm db:seed
pnpm test:db
```

Za ciljanu matricu može se koristiti postojeći pg_prove:

```bash
docker compose exec -T postgres pg_prove -U ductus -d ductus /db/tests/090-student-workspace.sql
```

Očekivanje: planirani broj pgTAP asercija i svi relevantni akteri imaju stvarno provjerene ishode. Odbijanje zbog nedostajućeg USAGE nije samo po sebi dokaz RLS-a.

Za novi RPC/migraciju izvršitelj slijedi .agents/skills/ductus-new-table: migrator bez superuser prečaca, grantovi, FORCE RLS, testovi mutacija i lokalni rollback/reapply u vlastitoj potrošnoj testnoj bazi. Produkcija migrira samo prema odobrenom postupku.

**UI — stvarni novi tok i postojeća pristupačnost**

```bash
pnpm test:e2e:login student-workspace.spec.ts
pnpm test:e2e accessibility.spec.ts --project=desktop --project=mobile
pnpm test:e2e screenshots.spec.ts --project=desktop --project=mobile
```

Prvi argument login suitea zamijeniti konkretnim novim spec-om, npr. assignment-roster.spec.ts. Login suite u pregledanom configu nema project nazvan chromium; standardni suite ima desktop/mobile/firefox/webkit. Nazive se ne smije zamijeniti napamet.

**TRUST — evidencija, oporavak, auth, predaja i RLS**

```bash
pnpm test:integration
pnpm test:e2e:login demo-flow.spec.ts
pnpm test:db
```

Uz to izvesti ciljane property, offline/concurrency i relevantne browser provjere koje traži TESTING. D-168 dopušta odgodu WebKita/Safarija nakon demoa; odgoda ne vrijedi automatski za stvarni pilot.

**Obvezna predaja**

```bash
pnpm test
pnpm build
pnpm orch:overlap
```

Primijeniti važeći pre-push/CI profil iz repoa. Ciljani brzi testovi tijekom rada ne zamjenjuju obvezne testove, formalni review ili QA. Ako projektna iznimka vrijedi, navesti je uz točan opseg.

##### 12.2 Točne predložene nove testne putanje

Postojeći testovi se proširuju gdje već pokrivaju ponašanje. Ovo su predložene putanje za nove provjere; brojeve pgTAP datoteka izvršitelj usklađuje s aktualnim mainom prije preuzimanja.

| Korak | Unit/DB test                                                                                                 | Browser dokaz                                |
| ----- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| B1/B2 | src/server/institution/student-workspace.test.ts; db/tests/090-student-workspace.sql                         | e2e/login/student-workspace.spec.ts          |
| B3    | src/components/teacher/AssignmentForm.test.ts                                                                | e2e/login/existing-course-assignment.spec.ts |
| B5/B6 | src/server/institution/assignment-roster.test.ts; db/tests/091-assignment-submissions.sql                    | e2e/login/assignment-roster.spec.ts          |
| B7/B8 | src/server/institution/assignment-version-route.test.ts; proširenje db/tests/032-institution-assignments.sql | e2e/login/assignment-version.spec.ts         |
| B9    | src/server/institution/deadline-extension.test.ts; db/tests/092-deadline-extension.sql                       | e2e/login/deadline-extension.spec.ts         |
| C2/C3 | src/server/institution/admin-people.test.ts; db/tests/093-institution-admin.sql                              | e2e/login/institution-admin.spec.ts          |
| C4    | src/server/audit/work-access.test.ts; db/tests/094-work-access-read.sql                                      | e2e/login/work-access.spec.ts                |
| C5    | src/server/evidence/checkpoint-read.test.ts; db/tests/095-document-checkpoints.sql                           | e2e/login/work-versions.spec.ts              |
| D1    | src/server/notifications/notifications.test.ts; db/tests/096-notifications.sql                               | e2e/login/notifications.spec.ts              |
| D2    | src/server/collaboration/revision-requests.test.ts; db/tests/097-revision-requests.sql                       | e2e/login/revision-requests.spec.ts          |
| D3    | src/server/institution/policy-versions.test.ts; db/tests/098-institution-policy.sql                          | e2e/login/institution-policy.spec.ts         |
| D4    | src/server/exports/request-export.test.ts; db/tests/099-exports.sql                                          | e2e/login/exports.spec.ts                    |

Scenariji/asercije nalaze se u odgovarajućem koraku. Namjena testova je dokazati ovlasti i stvarne ishode, bez testiranja same činjenice da komponenta vraća markup.

##### 12.3 Lokalna okolina i poznate granice

- Kanonske upute su docs/DEMO-UP.md i aktualni CI. Za interaktivni lokalni demo koristi se pnpm demo:up.
- Za automatizirani čisti prihvat koristi se postojeći demo:prepare/CI setup i okolina s lokalnim AUTH_DATABASE_URL, razvojnim potpisnikom i S3 domenom. demo:prepare i demo:up ne pripremaju isti seed scenarij.
- Runner ne prenosi generiranu lozinku natrag u parent shell. Za zasebno pokretanje login testova mora se koristiti već postojeći lokalni/CI način dostave potrebne okoline; ne pretpostaviti da sam slijed naredbi stvara sve auth varijable.
- Ne ispisivati ili upisivati tajne u plan, testni izvještaj ili repo.
- Ako lokalni uređaj ne može pokrenuti Docker, koristiti već odobreni izvršivi testni host/CI. Neizvedena provjera ostaje NEPROVJERENO.
- Prije svakog commita poštovati projektno pravilo zelenih testova. Stageati samo eksplicitne putanje, ne git add -A.

##### 12.4 Review, QA i migracije

- Svaki PR ima postojeći Task, Agent, Risk, invarijantu, stvarnog pozivatelja, poznate granice i zahtijevane dokaze.
- critical: neovisni review i zaseban QA na aktualnom headu, osim točno primjenjive važeće projektne iznimke. Nema vlastitog kanonskog PASS-a.
- Nova semantička izmjena invalidira prethodni verdict; primjenjivost D-101 dokazuje se, ne pretpostavlja.
- Dbmate generira stvarni UTC prefiks migracije u trenutku preuzimanja, nakon aktualne zadnje migracije. Imena baze migracije navedena u koracima jesu konkretna; prefiksi i slobodni brojevi pgTAP datoteka ne rezerviraju se ovim read-only planom.
- Izmjena s više od dopuštenog opsega dijeli se na smisleno pregledljive backend/UI korake. Plan ne daje iznimku od granice približno 300 produkcijskih/400 ukupnih kodnih redaka za critical PR.
- Poslije mergea izvesti postojeći smoke na točnom main SHA-u. Merge ne dokazuje deploy; deploy ne dokazuje pilot GO.

#### 13. Red rada, kapacitet i procjena

**Do zamrzavanja 28. 10.:** postojeći A1–A4 i već prihvaćeni dizajnerski popravci #732. Točan preostali broj sati nije provjeren; puni K-4 i aktualni gate određuju može li demo biti GO ili PARTIAL DEMO.

**Odmah paralelno na razini pripreme:** C1 ugovor i vanjski AAI/owner odgovori. Ne čekati dovršetak svih studentskih ekrana da se razriješi identitet za roster i admin.

**Nakon prihvata demoa:** B1 → B2; neovisno B3; B4 → B5 → B6. B7 → B8 i B9 dolaze u isti svakodnevni ciklus po kapacitetu. C2 → C3 može teći nakon C1; C4 i C5 po svojim postojećim zadacima/valovima.

**Kasnije prema PROGRAM:** D1, D2, D3 i D4 ne uvode se svi odjednom; obavijesti i osnovni izvoz imaju prednost prema cilju konkretnog pilota. Puni institucionalni policy editor, prenosivi paket i vremeplov poštuju odabrani val. E1 prati svaki korak; E2 čeka ADR, E3 stvarne GO ovisnosti.

| Paket                             |        Gruba procjena implementacijskog rada | Napomena                                                                                |
| --------------------------------- | -------------------------------------------: | --------------------------------------------------------------------------------------- |
| B: svakodnevni tokovi             |                            14–24 writer-dana | Zbroj Backend + Frontend, uz postojeće temelje i B4 podkorake                           |
| C: minimalni admin i privatnost   |                            10–18 writer-dana | C1 vanjsko čekanje nije u broju; C5 može ostati u kasnijem valu                         |
| D: obavijesti/dorade/policy/izvoz |                            18–32 writer-dana | Više odvojenih isporuka prema programu; opseg izvoza i policy ugovor mijenjaju procjenu |
| E2: početni ops portal            |                         Procjena nakon ADR-a | Neoznačena auth arhitektura nije vjerodostojno procjenjiva                              |
| E3: infrastruktura                | Postojeći zadaci i njihova aktualna procjena | Vanjski računi, AAI i institucionalni uvjeti imaju vlastite rokove                      |

To su planerske procjene, nisu izmjereni sati ni obećani datumi. Uz jedan Backend i jedan Frontend rad se djelomično preklapa, ali jedan Frontend ostaje usko grlo za više novih ekrana. Postojeći Platforma writer radi infrastrukturu i potrebne ovisnosti. Nitko nije pokrenut ili dodijeljen ovim dokumentom.

Ne uvoditi drugi pisac na iste datoteke. Poruke, PREUZETO i ograničenja gatea ostaju u postojećem sustavu; broj paralelnih planiranih tokova nije ovlast za dodatne sesije.

#### 14. Teme koje ostaju vidljive u postojećem programu

| Tema                                       | Kada se uključuje                           | Zašto nije dio prvog frontend reza                                                                 |
| ------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Više grupa i zamjenski/sunastavnici        | M2 ako odabrani pilot to traži              | Potreban model izvedbe kolegija i prijenos odgovornosti                                            |
| Gubitak uređaja / opoziv ostalih sesija    | Uz DAN-212/DAN-296 prije relevantnog pilota | Odvojeno od odjave trenutne kartice                                                                |
| Offline ponovno otvaranje/PWA              | Nakon posebnog auth/cache ugovora           | Trenutni offline editor ne dokazuje siguran offline startup                                        |
| Live skaliranje                            | Mjerenje 50/200/500 sintetičkih autora      | Ne mijenjati kanal i arhitekturu bez mjerenja                                                      |
| Samostalni mentorski radovi i povjerenstvo | PROGRAM val 3                               | Trenutni evidence projekt vezan je uz zadatak; tip master_thesis sam ne čini puni mentorski sustav |
| AI pomoćnik i integracije                  | Prema prihvaćenim flagovima/valovima        | Nisu preduvjet povezivanja osnovnih radova i predaje                                               |

#### 15. Preporučeni prvi provedbeni nalog

Ako vlasnik naknadno zatraži implementaciju, prvi nalog treba ostati u postojećem DAN-89/#711:

**Cilj:** dovršiti A1, A2 i A3 kroz njihove već dodijeljene podkorake, zatim izvršiti A4 na točnom spojenom SHA-u. Ne otvarati paralelni editor, novu bazu ili drugi K-4 test.

**Nakon toga:** prvi novi produktni rez je B1+B2 — Moji radovi na stvarnim podacima — i B3 kao zaseban mali tok za drugi zadatak u postojećem kolegiju.

**Prije početka bilo kojeg novog koraka:** aktualizirati izvore, pronaći/povezati Linear zadatak, provjeriti rezervacije i dogovoriti putanje. Sam ovaj plan nije preuzimanje zadatka.

#### 16. Izvori i provjerljiva polazišta

- [Pregledani main 5cd9cf8](https://github.com/danielrisavi77-create/Ductus/commit/5cd9cf8f28bca2804511db4ea166eb0c5c647250)
- [Linear Ductus](https://linear.app/daniel77/project/ductus-a9da19a077dc)
- [Protokol koordinacije](https://linear.app/daniel77/document/protokol-koordinacije-agenata-ductus-i-lekta-40749fe0b6d2)
- [PRODUCT](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/docs/PRODUCT.md), [ARCHITECTURE](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/docs/ARCHITECTURE.md), [BACKEND](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/docs/BACKEND.md)
- [PROGRAM](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/docs/PROGRAM.md), [PLAN-DEMO](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/docs/PLAN-DEMO.md), [DECISIONS](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/docs/DECISIONS.md)
- [TESTING](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/docs/TESTING.md), [DEMO-UP](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/docs/DEMO-UP.md)
- [Izvor studentskog dokumenta](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/src/server/evidence/work-document-read.ts)
- [Nastavnikovi kolegiji](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/src/server/institution/teacher-courses.ts)
- [Radovi zadatka](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/src/server/evidence/assignment-works.ts)
- [TeacherSetup](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/src/components/teacher/TeacherSetup.tsx)
- [Journal](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/src/lib/journal/atomic-dexie-journal.ts)
- [Revision request automat](https://github.com/danielrisavi77-create/Ductus/blob/5cd9cf8f28bca2804511db4ea166eb0c5c647250/src/domain/collaboration/revision-request.ts)
- [Postojeći #711](https://github.com/danielrisavi77-create/Ductus/issues/711), [#731](https://github.com/danielrisavi77-create/Ductus/pull/731), [#476](https://github.com/danielrisavi77-create/Ductus/issues/476), [#655](https://github.com/danielrisavi77-create/Ductus/issues/655), [#732](https://github.com/danielrisavi77-create/Ductus/issues/732)
- Prethodni datirani izvještaji služe kao navigacija; činjenične tvrdnje plana vezane su uz gornji repo i aktualno pročitane Linear zadatke.

### Karta ovisnosti i vlasničkih radnji

Povijesna mapa ID-eva i ovisnosti iz [izvorne revizije](https://github.com/ductura/.github/blob/265ea93a2e14a22902e17d259e31304278c30982/docs/plan/KARTA.md).

#### 1. Plan servera i weba: koraci

| Stavka plana                          | ID-evi                                                                                                                          | Repo                                                        | Paket                                               | Paritet / napomena                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 zapis odluka                      | S-0.1                                                                                                                           | Ductus                                                      | —                                                   |                                                                                                                                        |
| 0.2 mapa modula                       | S-0.12                                                                                                                          | server                                                      | —                                                   | uz B3 granice                                                                                                                          |
| 0.3 tiketi                            | —                                                                                                                               | orkestrator (Linear)                                        | —                                                   | ID-eve za U*, 2.c* dodjeljuje ovdje                                                                                                    |
| 1A.0 pravila koda                     | S-0.5, S-0.7, S-0.8                                                                                                             | server                                                      | preseti iz `.github`                                |                                                                                                                                        |
| 1A mape po područjima                 | S-1A-a, S-1A-b                                                                                                                  | server                                                      | —                                                   | B3: pet pravila granica u CI-ju                                                                                                        |
| 1B jedan `server.js`                  | S-1B-a, S-1B-b, S-1B-c                                                                                                          | server                                                      | —                                                   |                                                                                                                                        |
| 1F baze                               | S-1F-a … S-1F-e                                                                                                                 | server                                                      | S-1F-e puni `test-fakes`                            |                                                                                                                                        |
| 1J vrste računa                       | S-1J.1-a, S-1J.1-b, S-1J-c, S-1J-d, S-1J.2, S-1J.4                                                                              | server                                                      | —                                                   |                                                                                                                                        |
| 3a postavke po razinama               | S-1J-e, S-1J-f, S-1J-g                                                                                                          | server (API); ekrani u web (2.c4)                           | contracts                                           |                                                                                                                                        |
| 1L lokale                             | S-1L.1, S-1L.2, S-1L.3, S-1L.4, S-1L.5                                                                                          | server                                                      | —                                                   | lokale sučelja u web `packages/ui`                                                                                                     |
| 1K.1–1K.3 zapisi                      | S-1K.1, S-1K.2-a, S-1K.2-b, S-1K.3-a, S-1K.3-b                                                                                  | server                                                      | lažna baza zapisa u `test-fakes`                    |                                                                                                                                        |
| 1C promet i IP                        | S-1C.1 … S-1C.6                                                                                                                 | server                                                      | —                                                   |                                                                                                                                        |
| 1D sesije                             | S-1D-a … S-1D-d                                                                                                                 | server                                                      | —                                                   |                                                                                                                                        |
| 1E vanjski servisi                    | S-1E-a … S-1E-g                                                                                                                 | server                                                      | lažni OIDC i FIDO2 u `test-fakes`                   |                                                                                                                                        |
| 1K.4–1K.6 metrika, pregledi, izvoz    | S-1K.4-a, S-1K.4-b, S-1K.5-a, S-1K.5-b, S-1K.6                                                                                  | server (API); pregledi u web                                | contracts                                           |                                                                                                                                        |
| 1K.7–1K.9                             | S-1K.7-a, S-1K.7-b, S-1K.7-c, S-1K.8, S-1K.9                                                                                    | server                                                      | —                                                   |                                                                                                                                        |
| 1M stanje, kontekst, katalog grešaka  | S-1M-a, S-1M-b, S-1M-c                                                                                                          | server                                                      | contracts                                           | ulaz za P-0.4, P-0.5, P-0.8                                                                                                            |
| 1N i 3d pravni dio                    | S-1N-a … S-1N-d                                                                                                                 | server (API, baza); prikaz u preloader (P-0.6, P-0.9) i web | contracts                                           |                                                                                                                                        |
| 3b brisanje radova                    | S-3B-a … S-3B-e                                                                                                                 | server; ekrani u web                                        | contracts                                           | S-3B-e i izvršni dio S-3B-b/d čekaju D-30, Q-16                                                                                        |
| uski rez za VS-1 (O-3)                | ID-eve dodjeljuje orkestrator                                                                                                   | server                                                      | —                                                   | sesija, `open`, `commit`, `replay`; zasebni `critical` PR-ovi redom iza S-0.19, usporedno s valovima 1–5; nije izdanje (migracija §4c) |
| val 6 prijenos područja               | S-M-1, S-M-2a, S-M-2b, S-M-3, S-M-4, S-M-5, S-M-6, S-M-7, S-M-8, S-M-10                                                         | server                                                      | —                                                   | A2: s testovima; S-M-9 namjerno izostavljen u zadacima                                                                                 |
| 1G backup                             | S-1G-a … S-1G-f                                                                                                                 | server                                                      | —                                                   |                                                                                                                                        |
| 1H ugovori (ranije dio)               | S-1H.1-a, S-1H.1-b, S-1H.1-c, S-1H.4 (= U4–U7)                                                                                  | server                                                      | contracts                                           | **A3/B1: pomaknuto odmah nakon kostura**                                                                                               |
| 1H ugovori (kasniji dio)              | S-1H.2, S-1H.3, S-1H.5, S-1H.6, S-1H.7, S-1H.8                                                                                  | server                                                      | contracts, test-fakes                               | S-1H.8 = kostur pariteta                                                                                                               |
| lažni server iz ugovora               | U8                                                                                                                              | server                                                      | test-fakes                                          | nov (A3)                                                                                                                               |
| zajednički paket lažnih zamjena       | U9                                                                                                                              | server                                                      | test-fakes                                          | nov (B4)                                                                                                                               |
| objava paketa                         | T-0.5 (= U10)                                                                                                                   | server                                                      | contracts, test-fakes                               | GitHub Packages (B1)                                                                                                                   |
| 1I završni CI                         | S-1I                                                                                                                            | server                                                      | —                                                   |                                                                                                                                        |
| val 0 temelj repoa                    | S-0.4, S-0.6, S-0.9, S-0.10-a, S-0.10-b, S-0.11, S-0.13, S-0.14, S-0.15, S-0.16, S-0.17, S-0.18, S-0.19 (S-0.20 ukinut 17. 11.) | server                                                      | S-0.16 → test-fakes; S-0.10-a/b skripte u `.github` |                                                                                                                                        |
| val 0 u Ductusu                       | S-0.2, S-0.3, S-0.21                                                                                                            | Ductus                                                      | —                                                   | S-0.2 ulaz u U4; S-0.3 odlučuje PGlite u test-fakes                                                                                    |
| 2.0 i 3c preloader                    | P-0.1 … P-0.11                                                                                                                  | preloader                                                   | contracts, test-fakes, ui                           | A3: ovise o shemi, ne o serveru (osim P-0.10)                                                                                          |
| 2.1 i 3e info stranica                | P-0.9                                                                                                                           | preloader                                                   | ui                                                  |                                                                                                                                        |
| 2.c1 popis i katalog komponenti       | —                                                                                                                               | web                                                         | ui                                                  | B5: vizualni testovi od prvog zadatka                                                                                                  |
| 2.c2 testovi komponenti               | —                                                                                                                               | web                                                         | ui                                                  |                                                                                                                                        |
| 2.c3 tipizirani klijent               | —                                                                                                                               | web                                                         | contracts                                           | ← U10                                                                                                                                  |
| 2.c4 komponente po području           | —                                                                                                                               | web                                                         | contracts, ui, editor-core                          | ← 2.c3, shema rute, vektori U7 i U8, oznake iz 2.c1 (§1b migracije)                                                                    |
| 2.c5 `src/platform`                   | —                                                                                                                               | web                                                         | —                                                   | uključuje bivše 2.c7 i 2.c8 (A1)                                                                                                       |
| 2.c6 e2e                              | —                                                                                                                               | web                                                         | parity, test-fakes                                  | matrica: Chromium/Chrome, Firefox, WebKit, Edge, mobilna emulacija; Opera ručno                                                        |
| 2.c7 mobilni web                      | —                                                                                                                               | web                                                         | —                                                   | A1: spojeno u 2.c5/2.c6                                                                                                                |
| 2.c8 ostali preglednici               | —                                                                                                                               | web                                                         | —                                                   | A1: spojeno u 2.c5/2.c6                                                                                                                |
| 2.c9 stranica za preuzimanje          | P-0.9                                                                                                                           | preloader                                                   | contracts                                           | vidi §4                                                                                                                                |
| faza 3 desktop                        | D-0.1, „Faza E · aktivacija desktop razvoja”                                                                                    | Ductus (D-0.1), desktop-windows, desktop-macos              | contracts (C#/Swift klijent)                        | kasnije                                                                                                                                |
| gate prema riziku uz ugovorne testove | U11                                                                                                                             | `.github`                                                   | —                                                   | B6: zadnje; zaseban PR pravila, vlasnik potvrđuje                                                                                      |

#### 2. Plan migracije: novi zadaci (§10b)

| ID                         | Repo                     | Napomena                                                                                                                                                               |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-0.1, T-0.2, T-0.4, T-0.7 | `.github`                | T-0.3 ukinut 17. 11.; B2: T-0.1, T-0.2, T-0.4 odmah nakon kostura (U2); preseti nov zadatak                                                                            |
| T-0.5                      | server                   | = U10                                                                                                                                                                  |
| T-0.6                      | Ductus                   | skripte orkestratora za više repoa (popis: 5 + `.github` + Ductus)                                                                                                     |
| P-0.1 … P-0.11             | preloader                |                                                                                                                                                                        |
| D-0.1                      | Ductus (`spikes/`)       | nakon faze B                                                                                                                                                           |
| E-0.1, E-0.2               | Ductus                   | editor-core nastaje u Ductusu                                                                                                                                          |
| E-0.3                      | web                      |                                                                                                                                                                        |
| VS-1                       | preloader + web + server | jedini zadatak preko tri repoa; nositelj PRIJEDLOG web. O-2: samo sintetički podaci, protokol 1 (potpis u istom odgovoru), uključuje VS-1.13; ovisi o uskom rezu (O-3) |
| VS-1b                      | server + web             | O-2: `202 pending_signature`, worker, red poslova, oporavak; bezuvjetan; uvjet za osnovicu 20. 12. 2026. i za stvarne podatke (D-71); ovisi o VS-1                     |
| VS-2                       | web                      | A1: mobilni prikaz u istom repou                                                                                                                                       |
| M-0.1                      | Ductus                   | mjere                                                                                                                                                                  |

#### 3. Vlasničke radnje

| ID   | Što (sažeto)                                                                                                                     | Repo                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V-0  | domena `ductura.org` (odlučeno 17. 11., Ductus#2012 c.6934113245) i adresa e-pošte (otvoreno); konačan prije zahtjeva Srcu (R-4) | sve (preloader proxy)                                                                                                                                                    |
| V-1  | organizacija `Ductura` i repo `server` (gotovo 14. 11.)                                                                          | server; B2 dodaje `.github`                                                                                                                                              |
| V-1b | aktivacija repoa po fazama (migracija)                                                                                           | preloader i web (odobreno 14. 11., ne čeka fazu C); desktop je zasebna radnja „Faza E · aktivacija desktop razvoja”; arhiviranje `web-mobile`, `web-other` nakon potvrde |
| V-2  | zaštita grane, `ci-ok`, statusi gatea                                                                                            | svaki repo                                                                                                                                                               |
| V-3  | aplikacija botova                                                                                                                | svaki repo                                                                                                                                                               |
| V-4  | tajne i CI runneri                                                                                                               | server                                                                                                                                                                   |
| V-5  | zahtjev Srcu (registracija, ne-preglednički klijent); tek nakon konačnog V-0 (R-4)                                               | server (S-1E-b, S-1E-e)                                                                                                                                                  |
| V-6  | backup u produkciji                                                                                                              | server (nakon S-1G-e)                                                                                                                                                    |
| V-7  | račun admina aplikacije izvan aplikacije                                                                                         | server (nakon S-1J.1-b)                                                                                                                                                  |

#### 4. Plan prvog vala (13. 11.)

| Stavka                                                                  | Repo                                                                                                  | Napomena                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| §1 koraci 1–3 (domena, preusmjeravanje, dijelovi)                       | preloader (proxy), V-0                                                                                | domena `ductura.org` (17. 11.)                     |
| §2 sedam dijelova u jednom `main`                                       | zamijenjeno: 5 repoa + `.github`                                                                      | shared-core → paketi u serveru i webu              |
| §2 shared-core                                                          | `@ductura/contracts`, `@ductura/test-fakes`, `@ductura/ui`, `@ductura/editor-core`, `@ductura/parity` |                                                    |
| §3 redak Win Chrome                                                     | preloader                                                                                             | A1: web, prikaz računalo, gumb Windows             |
| §3 redak Mac Chrome                                                     | preloader                                                                                             | web, računalo, macOS                               |
| §3 redak Win Edge/Firefox/Opera                                         | preloader                                                                                             | web, računalo, Windows                             |
| §3 redak Mac Safari/Firefox                                             | preloader                                                                                             | web, računalo, macOS                               |
| §3 redak mobitel/tablet                                                 | preloader                                                                                             | web, prikaz mobilno, bez paketa                    |
| §3 redak Linux/nepoznat                                                 | preloader                                                                                             | web, računalo, ručni izbor paketa                  |
| §3 rubni: iPad desktop, uski prozor, nema paketa                        | preloader                                                                                             |                                                    |
| §4 server: vlastiti/tuđi; prazan/neispravan ID                          | server                                                                                                | S-1H.3, S-1H.1-c                                   |
| §4 Chrome: otvori, spremi, osvježi; zamjena                             | web                                                                                                   |                                                    |
| §4 mobitel: tipkovnica, okretanje iPada                                 | web                                                                                                   | A1                                                 |
| §4 ostali: učitavanje, navigacija, međuspremnik, dopuštenje             | web                                                                                                   | A1; Opera ručno                                    |
| §4 Windows: preuzimanje, instalacija, Start; razmaci i hrvatski znakovi | desktop-windows                                                                                       | faza E                                             |
| §4 macOS: preuzimanje, Applications, arhitektura                        | desktop-macos                                                                                         | faza E                                             |
| §4 shared-core/preloader: matrica                                       | preloader                                                                                             | P-0.2, P-0.11                                      |
| §5 koraci 1–5                                                           | po stavkama iznad                                                                                     | prihvat vala s instalacijom desktopa: **otvoreno** |

#### 5. Stavke koje ne pašu čisto (s preporukom)

1. **Zadaci u Ductusu** (S-0.1, S-0.2, S-0.3, S-0.21, T-0.6, M-0.1, E-0.1, E-0.2, D-0.1): ostaju u Ductusu. Preporuka: Ductus se ne zamrzava dok E-0.2 i S-0.2 nisu gotovi. **O-1:** ni prije izbora sustava za pilot na kontrolnoj točki 20. 12. 2026. (D-295).
2. **CSP** (`src/server/http/content-security-policy.ts`): opisuje stranice, a server ih nema. Preporuka: prijenos s testom u preloader `deploy/edge/`; proxy postavlja CSP za preloader i web.
3. **Stranica za preuzimanje**: zadaci §6 je stavljaju u web (2.c9), migracija P-0.9 u preloader. Preporuka: preloader (javna, prije prijave).
4. **Sinkronizacija u editor-coreu**: migracija §2c traži „osam stanja” u paketu i navodi `src/lib/sync`, a stroj je u `src/domain/sync` i `src/domain/serverSync`, koje §3 šalje kopijom. Preporuka: oba u `@ductura/editor-core` s testovima.
5. **VS-1** je preko tri repoa. Preporuka: nositelj web, PR-ovi po repou povezani jednim issueom; sistemski e2e u preloaderu.
6. **`@ductura/parity`** nedostaje u tablici paketa migracije §2c. Preporuka: dodati (web).
7. **Hosting proxyja** (domena odlučena: `ductura.org`): nijedan izvor ne odlučuje gdje radi proxy i server u produkciji ni trošak. **Otvoreno** (V-0, trošak).
8. **Putanja weba**: nakon A1 nema `/c/`, `/m/`, `/o/`. Preporuka: jedna putanja (npr. `/app/`), uz odluku 1.
9. **GitHub Packages i token**: npm registar GitHub Packagesa traži token i za javne pakete. Preporuka: u CI-ju `GITHUB_TOKEN` s `packages: read` i dodijeljenim pristupom repou; za lokalni rad osobni token. Ako to smeta vanjskim suradnicima, javni npm opseg je besplatna zamjena (nova vlasnička odluka).
10. **Testovi bez Dockera (B4) i pravi PostgreSQL**: ovlasti i RLS traže pravi PostgreSQL. Preporuka: nativni PostgreSQL na runneru (kao Ductus `native-db.mjs`); Docker slika S-1H.7 samo kao izdanje.
11. **Prijava admina aplikacije s FIDO2** (plan 3c) nije u P-0.7 (pitanje 8). Ostaje otvoreno.
12. **Potpis desktop paketa**: Windows certifikat i Apple Developer ID (oko 99 USD godišnje) su trošak izvan onoga što vlasnik plaća. **Otvoreno.**

## Povijesni program backenda

Izvorni tehnički kriteriji iz [revizije prije objedinjavanja](https://github.com/ductura/.github/blob/265ea93a2e14a22902e17d259e31304278c30982/docs/ductus/backend/program.md). Procjene, pružatelji i rokovi iz ovog zapisa datirani su. Za izvođenje i objavu primjenjuju se aktualna arhitektura, prihvaćene odluke i uvjeti faza iz glavnog dijela dokumenta.

Dio plana backenda. Verzija, status i popis svih odjeljaka su u indeksu `docs/BACKEND.md`; brojevi odjeljaka su isti kao u indeksu, pa referenca "`BACKEND.md` §N" vodi ovamo.

#### 5. Što još nije potvrđeno (spike prije odluke)

| Stavka                                                                                                                                                                                                                                                                                                                    | Provjera                                                                                                                                                                           | Gdje        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Uvjetni upis kod dobavljača pohrane (dodana provjera, odluka 11. 10. 2026., D-08)                                                                                                                                                                                                                                         | Provjera kod dobavljača pohrane                                                                                                                                                    | B0.1        |
| Ključevi po spremniku kod dobavljača pohrane (dodana provjera, odluka 11. 10. 2026., D-08)                                                                                                                                                                                                                                | Provjera kod dobavljača pohrane                                                                                                                                                    | B0.1        |
| PostgreSQL 17 i ovlasti nad ulogama kod upravljane baze (dodana provjera, odluka 11. 10. 2026., D-08)                                                                                                                                                                                                                     | Provjera kod upravljane baze                                                                                                                                                       | B0.1        |
| Povrat u točku na UpCloud Developer: postupak (Hub, API ili podrška), stvarni RPO, trajanje, stvara li novu instancu                                                                                                                                                                                                      | Dodatak A, oko 30 minuta i nekoliko centi                                                                                                                                          | B0.1        |
| Cijene UpCloud VM-a: sažeci cjenika se razlikuju (Cloud Native 4 GB / 1 vCPU 12 EUR i 8 GB / 2 vCPU 24 EUR prema jednom, 2 vCPU / 4 GB 15 EUR prema drugom) i je li disk uključen                                                                                                                                         | Pogledati cjenik u konzoli pri otvaranju računa                                                                                                                                    | B0.1        |
| Uloge na upravljanoj bazi: `CREATE ROLE NOLOGIN`, `ALTER FUNCTION OWNER`, `GRANT role TO role`, `max_connections`, promjena log parametara, ekstenzije                                                                                                                                                                    | Pokrenuti skriptu uloga i pgTAP                                                                                                                                                    | B0.1        |
| Zapisivanje parametara naredbi za aplikacijsku prijavu (F-036, DAN-169): smiju li se postaviti `log_parameter_max_length = 0` i `log_parameter_max_length_on_error = 0`, vodi li pružatelj zapis upita izvan PostgreSQL postavki, i prolazi li provjera web procesa (`src/server/db/log-settings.ts`) na upravljanoj bazi | Postavke u konzoli pružatelja i prvi `withActor` poziv na stagingu                                                                                                                 | B0.1        |
| Latencija VM do baze i trajanje `reserve`                                                                                                                                                                                                                                                                                 | Mjerenje                                                                                                                                                                           | B0.1        |
| Jesu li UpCloud Cloud Native tipovi dostupni i po kojoj cijeni za računalo koje ne guši pri rekonstrukciji                                                                                                                                                                                                                | Cjenik i narudžba                                                                                                                                                                  | B0.1        |
| Rekonstrukcija 15.000 i 80.000 riječi (vrijeme, memorija, volumen kontrolnih točaka)                                                                                                                                                                                                                                      | Lokalna osnovica gotova 3. 10. 2026. (`docs/spikes/B0.2.md`): CPU i memorija nisu problem, volumen točaka svakih 200 koraka jest. Ostaje ponoviti na stroju koji se stvarno kupuje | B0.2        |
| AWS KMS Ed25519 u eu-central-1: latencija potpisa                                                                                                                                                                                                                                                                         | Mjerenje                                                                                                                                                                           | B0.1        |
| Uvjeti za partnera AAI@EduHr (može li obrt ili fizička osoba), rokovi, trajnost identifikatora                                                                                                                                                                                                                            | Pitati Srce, ali tek ako FPZG put ne uspije (§4.3)                                                                                                                                 | Owner queue |
| FINA: minimalna mjesečna naknada, uvjeti, tko je ugovorna strana                                                                                                                                                                                                                                                          | Upit                                                                                                                                                                               | Owner queue |
| Sentry EU na besplatnom planu                                                                                                                                                                                                                                                                                             | Pročitati                                                                                                                                                                          | B9          |

B0.1 je pomaknut naprijed (odluka vlasnika 11. 10. 2026., D-08), rok 16. 11. 2026.; preduvjet su računi dobavljača (Owner queue u `STATE.md`). **Odluka vlasnika 11. 10. 2026. (tumačenje točke 3, potvrđeno; issue #87, komentar 6105263690):** migracije na kritičnom putu demoa (#240 i sljedeći korak B-8) se ne zaustavljaju; B0.1 kreće čim postoje računi dobavljača; rizik prepisa migracija do tada ostaje zapisan.

Riješeno 3. 10. 2026.: cijena KMS-a (službeni cjenik), uvjeti besplatnih TSA-ova (ne postoje objavljeni, zato dva neovisna žiga), tko registrira AAI klijenta (§4.3), PITR mehanizam na UpCloud-u (dokumentacija). Ostaje samo ono što traži račun: stvarni povrat i cijene u konzoli.

#### 7. Trošak (procjena 3. 10. 2026., EUR godišnje)

| Stavka                                                                               | Bez PDV-a          | Napomena                                                                                 |
| ------------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------- |
| UpCloud Cloud Native VM (2 vCPU / 4 GB, 15 EUR mjesečno)                             | oko 180            | Veći tip (4 vCPU / 8 GB, 32 EUR mjesečno, oko 384) ako B0.2 traži; disk možda dodatno    |
| UpCloud Managed PG Developer 2 GB (14 EUR mjesečno)                                  | oko 168            | PITR 3 dana; bez HA i SLA; disk NEPROVJEREN                                              |
| Scaleway Object Storage                                                              | 5 do 10            |                                                                                          |
| Scaleway TEM                                                                         | oko 14             |                                                                                          |
| Replika bucketa (drugi račun)                                                        | 10 do 40           |                                                                                          |
| AWS KMS (2 ključa, 100.000 potpisa mjesečno)                                         | oko 40             | 1 USD po ključu mjesečno + 0,15 USD na 10.000 potpisa, službeni cjenik                   |
| Domena `.hr`                                                                         | 15 do 30           | sekundarni izvor                                                                         |
| TSA žigovi                                                                           | 0                  | Dva besplatna TSA-a; FINA kasnije oko 40 EUR godišnje + certifikat 86,27 EUR na 5 godina |
| Praćenje grešaka i vanjski monitor                                                   | 0 do 20            |                                                                                          |
| Staging (privremeni resursi tjednima prije aktivacije, naplata po satu NEPROVJERENA) | 30 do 100          | Staging mora koristiti upravljanu bazu, KMS i S3 (§6 točka 12)                           |
| **Ukupno**                                                                           | **oko 460 do 600** |                                                                                          |
| **S PDV-om (oko +25 %)**                                                             | **oko 575 do 750** | PDV se naplaćuje fizičkoj osobi bez obrta u sustavu PDV-a; potvrditi sa računovođom      |

To je bilo **iznad D-66** (infrastruktura 300 do 500 plus domena i e-pošta 50 do 100). Od 1. 11. 2026. proračun pilota je 10.000 EUR (D-199 t. 2), a PRIJEDLOG raspodjele daje infrastrukturi oko 1.000 EUR, pa obje varijante stanu bez rezanja sigurnosne stavke. Izbor varijante i dalje je odluka vlasnika nakon B0.1:

- **Varijanta A (preporuka ako B0.1 prođe):** gore opisano. Ranije je dodatni trošak trebala pokriti rezerva iz D-69 uz smanjenje stavke "sigurnost"; uz D-199 to više nije potrebno.
- **Varijanta B:** Hetzner VM (ako se CX tip stvarno može naručiti; CPX32 dodaje oko 280 EUR godišnje) + PostgreSQL s WAL-G na vlastitom VM-u, bez upravljane baze. Jeftinija, ali PITR, nadogradnje i proba povrata postaju tvoj posao; baza ima javnu adresu ili tunel.
- Rezanje po potrebi: FINA tek s ugovorom, staging samo u zadnjim tjednima, replika bucketa na jeftiniji spremnik, jedan KMS ključ za prvi mjesec.
- Pri 5 puta većem broju korisnika procjena je 160 do 300 EUR mjesečno, iznad stavke infrastrukture iz D-199 t. 2; to je tada pitanje financiranja.

#### 8. Program backenda

Backend nije posebna faza nego okomiti rez kroz M0 do M11. **Procjena dodatka prema `PROGRAM.md`: realno 18 do 25 večeri** (v0.1 je rekao +6 do +10 bez osnove; uklonjeni Supabase poslovi nikad nisu bili zasebno procijenjeni, pa se "neto" ne može izračunati). Preporučujem da se dodatak vodi kao zaseban red u valu 1.

| Korak                     | Sadržaj                                                                                                                                                                                                                                                                                               | Izlazni kriterij                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Faza                                                                                                                            | Večeri                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| B0.1 Spike okruženja      | UpCloud VM + Managed PG, skripta uloga, PITR povrat u točku, RTT, log parametri, KMS ključ                                                                                                                                                                                                            | Zapis s brojkama; PITR radi ili se odabire varijanta B                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | prije M2 (migracije demoa ne čekaju B0.1, §5); pomaknut naprijed 11. 10. 2026., rok 16. 11. 2026., uz tri dodatne provjere (§5) | 2 do 3                                            |
| B0.2 Spike rekonstrukcije | ProseMirror u Nodeu za 15.000 i 80.000 riječi na stvarnom stroju                                                                                                                                                                                                                                      | Vrijeme, memorija, volumen; granice posla određene                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | prije M3                                                                                                                        | 1 do 2                                            |
| B0.3 Odluka               | Vlasnik potvrđuje dio D-08 o dobavljačima i trošku, D-72, D-73 (samo izbor biblioteke; vlastiti OIDC klijent odlučen 11. 10. 2026., a sesije u bazi i identitet u RLS-u potvrđeni u D-90) i D-75 prema rezultatima (D-71 i D-74 potvrđene 10. 10. 2026.; dio D-08 o aplikaciji odlučen 11. 10. 2026.) | ODLUČENO u `DECISIONS.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                                                 | 0                                                 |
| B0.4 Prepis ARCHITECTURE  | Cijeli dokument (uključujući §2, §3, §8, §11), §12 s točnim popisom prijenosa                                                                                                                                                                                                                         | Bez Supabasea i Netlifyja                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | M0                                                                                                                              | 1 do 2                                            |
| B1 Okruženja              | `docker compose` (Postgres, S3-kompatibilna pohrana (RustFS), Mailpit, lažni OIDC), OpenTofu (dva računa), CI deploy, migracijski alat, `sops`/`age`, uloge, Caddy, deploy s VM-a                                                                                                                     | `docker compose up` i `npm test` zeleno; staging se podiže iz koda                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | M0                                                                                                                              | 5 do 7                                            |
| B2 Identitet              | OIDC klijent s popisom iz §4.3, sesije, `current_actor()`, `withActor`, test GUC-a, odjava                                                                                                                                                                                                            | Prijava na AAI Labu; svi testovi iz §4.3 zeleni; nema lažnog pružatelja u produkciji                                                                                                                                                                                                                                                                                                                                                                                                                                                        | M1                                                                                                                              | 3 do 5 (uz sigurnosni pregled, neovisan o autoru) |
| B3 Ovlasti                | Novi referentni model, `can()`, RLS, pgTAP matrica, diferencijalni test                                                                                                                                                                                                                               | Matrica zelena                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | M2                                                                                                                              | uključeno u M2, +1                                |
| B4 Evidencija             | Točan popis prijenosa (§2), novi RPC-i, okidači, uloge, jedan RPC za commit i `reserve`, worker potpis preko KMS-a, kontrolne točke, praznine                                                                                                                                                         | Ugovorni testovi nad in-memory i pg/S3; B4 test dokazuje 0-based indekse bez praznina pod konkurentnim prihvatima, rollbackom i idempotentnim retryjem; property testovi; sintetički prolaz na stagingu s povratom                                                                                                                                                                                                                                                                                                                          | M3                                                                                                                              | +5 do 8                                           |
| B5 Dnevni korijen i žig   | Kumulativni log i dnevna kontrolna točka (D-93), consistency dokaz, KMS potpis uz usporedbu s potpunom vanjskom append-only poviješću, TSA, objava, neovisni primatelji i CLI verifikator                                                                                                             | Neovisna provjera prolazi; C2SP known-answer vektor kontrolne točke iz §4.1 prolazi standardnim verifierom, uključujući negativne slučajeve; promjena odsječka ruši provjeru; dan bez TSA-a se oporavlja; test povrata baze dokazuje da se regresivni ili razgranati checkpoint ne potpisuje, žigoše ni objavljuje; konkurentni `reserve` tijekom cutovera s praznim inventarom ne može upasti između snapshot-a i prve vanjski pohranjene kontrolne točke, a nakon otvaranja gatea dobiva indeks 0; kvar cutovera ostavlja gate zatvorenim | M3 do M7                                                                                                                        | 4 do 5                                            |
| B6 Poslovi i obavijesti   | pg-boss, retention (uklj. verzije), e-pošta, `notification` s prozorom P-03                                                                                                                                                                                                                           | Ponovljen posao ne duplicira učinak; nastavnik ne dobiva obavijest češće od P-03                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M6, M7, M10                                                                                                                     | +1 do 2                                           |
| B7 AI proxy               | U pilotu (D-194, mijenja D-77); pružatelj i model računa su otvoreni, pa je sadržaj paketa PRIJEDLOG                                                                                                                                                                                                  | Samo odobreni pružatelji; kineski pružatelji i modeli nedostupni; regija obrade zabilježena uz odgovor                                                                                                                                                                                                                                                                                                                                                                                                                                      | M9                                                                                                                              | procjena nije dana                                |
| B8 Predaja                | `requested_at`, rekonstrukcija u workeru, usporedba JCS                                                                                                                                                                                                                                               | Točna na svim scenarijima uključujući prazninu i pred-rokovni val                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | M7                                                                                                                              | uključeno u M7                                    |
| B9 Operacije i GO         | Backup i replika bucketa, mjesečna proba povrata (baza i bucket), alarmi, statusna stranica, `OPERATIONS.md`, load test, OWASP, popis podizvršitelja s DPA-ima                                                                                                                                        | Svi crveni GO uvjeti zeleni; zapisana proba povrata                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | M11                                                                                                                             | +3 do 4                                           |

Redoslijed i kontrolna točka 15. 12. 2026.:

1. B0.1 i B0.2 dolaze prije vezivanja za dobavljača; do tada M0 piše samo kod iza sučelja (baza, objekti, e-pošta, potpis, vrijeme).
2. B0.1 je **blokiran računima** kod UpCloud-a i AWS-a (Owner queue).
3. B5 se ne reže u prvom rezu. Ako treba rezati: prvo web verifikator (ostaje CLI), zatim objava u javni repozitorij (korijen, potpis i žig ostaju). **FINA ugovor nije GO preduvjet**; produkcija može krenuti s besplatnim TSA-om uz upisanu posljedicu.
4. Vanjske ovisnosti na kritičnom putu: Srce (2 do 6 tjedana je moja procjena, ne izvor; privatni subjekt možda mora preko FPZG administratora ili postati partner federacije), FINA, PR #49 i #50 (blokiraju M0), računi dobavljača.
5. Kapacitet iz `PROGRAM.md` (10 jedinica tjedno) računa samo Ductus; M4 traži rad u Lekti, a vlasnik vodi i druge projekte. Zato kontrolna točka ostaje stvarna, ne formalna.

#### 9. Što treba od vlasnika

- Potvrditi ili promijeniti dio D-08 o dobavljačima i trošku, D-72, D-73 (samo izbor biblioteke; vlastiti OIDC klijent odlučen 11. 10. 2026., a sesije u bazi i identitet u RLS-u potvrđeni u D-90) i D-75 (D-71 i D-74 potvrđene 10. 10. 2026.; dio D-08 o aplikaciji odlučen 11. 10. 2026.; vidi i odluku o troškovima u §7).
- Računi: UpCloud, Scaleway (Object Storage, TEM), AWS (samo KMS, IAM korisnik s uskim ovlastima), 2FA svugdje, agent dobiva ograničene ključeve po okolišu.
- **FPZG, ne Srce, je prvi korak za AAI:** zamoliti odgovornu osobu FPZG-a za AAI@EduHr da (1) e-poštom na `aai@srce.hr` ovlasti Daniela za AAI@EduHr Lab i (2) registrira Ductus kao uslugu FPZG-a u Registru resursa (OIDC klijent, redirect URI, scopeovi). Tekst zahtjeva je u Dodatku B.
- FINA: tek kad postoji obrt (ili ako FPZG želi biti ugovorna strana); do tada dva besplatna TSA-a.
- Računovođa: PDV za fizičku osobu bez obrta.
- Lokalni stroj s Dockerom za M0.

#### Dodatak A: proba povrata u točku na UpCloud-u (B0.1)

Cilj: dokazati da povrat u točku stvarno radi, izmjeriti RPO i trajanje. Traje oko 30 minuta, trošak je nekoliko centi (naplata po satu, instanca se briše nakon probe).

1. U UpCloud Hubu stvoriti Managed PostgreSQL, plan Developer, zona `de-fra1` (ili `fi-hel1`), u privatnoj mreži s jednim malim VM-om.
2. S VM-a pokrenuti pisanje markera svakih 10 sekundi, 20 minuta:
   ```sql
   create table pitr_probe (id bigserial primary key, written_at timestamptz not null default clock_timestamp());
   ```
   ```bash
   for i in $(seq 1 120); do psql "$DATABASE_URL" -qc "insert into pitr_probe default values"; sleep 10; done
   ```
3. Zapisati točno vrijeme T (UTC) oko 12. minute; zatim obrisati sve: `delete from pitr_probe;` (simulirana greška).
4. U Hubu (ili kroz podršku ako Hub to ne nudi) zatražiti povrat u točku T. Zapisati: gdje je opcija, stvara li novu instancu ili prepisuje postojeću, koliko traje.
5. Na vraćenoj bazi: `select max(written_at) from pitr_probe;` RPO = T minus `max(written_at)`. Očekivano do 5 minuta prema dokumentaciji.
6. Isto na istoj instanci: provjera uloga (`create role ductus_evidence nologin; grant ...; alter function ... owner to ...`), `show max_connections;`, smije li se mijenjati `log_statement` i `log_min_error_statement`.
7. Rezultat u `docs/spikes/B0.1.md`: koraci, vremena, RPO, slike zaslona, odluka. Obrisati instance.

Ako povrat u točku nije dostupan na Developer planu ili traje predugo: Neon Launch (PITR 7 dana) ili varijanta B, odluka vlasnika.

#### Dodatak B: zahtjev FPZG-u za AAI@EduHr

> Poštovani, za pilot alata Ductus na FPZG-u (pisanje studentskih radova uz evidenciju procesa) prijava studenata i nastavnika ide isključivo preko AAI@EduHr. Prema pravilima AAI@EduHr uslugu može registrirati matična ustanova, a pristup AAI@EduHr Labu odobrava ovlašteni predstavnik ustanove. Molim (1) da ovlastite Daniela Rišavija za korištenje AAI@EduHr Laba e-porukom na aai@srce.hr i (2) da, kad Lab test prođe, registrirate Ductus kao uslugu FPZG-a u Registru resursa (OpenID Connect; tražimo samo atribute hrEduPersonUniqueID, hrEduPersonHomeOrg, hrEduPersonAffiliation i ime; OIB ne). Tehničke podatke (redirect URI, logout URI) dostavit ću. Hvala.
