# SRV-IP-OGRANICENJE: ograničenja po IP-u i fakultet iza jedne adrese (NAT)

Samo analiza i prijedlog. Odluka Daniela 27. 11. 2026. („Da, smiješ”, „sve ove prijedloge ti odobravam”). Ništa u konfiguraciji ni u kodu nije promijenjeno; provedba je zaseban zadatak nakon pregleda. Izvor je kod na bazi `migracija/kopija-ductus-backend` (fbd5f75). Polazište je nalaz [ISTR-9](opterecenje-2611.md), točke 1 i 3.

## Sažetak

- Fakultet iza NAT-a izgleda kao jedna adresa. Sva ograničenja po IP-u tada dijele svi studenti, a **zadana ograničenja nisu napravljena za to**.
- Najtvrđe je ograničenje prijave: 30 u minuti po IP-u, a jedna prijava troši 2 mjesta. To je **15 prijava u minuti** po fakultetu, pa 300 studenata na početku nastave čeka oko 19 minuta, 1000 oko 66, 2000 oko 132.
- Spremanje po IP-u (1200, 20/s) drži 300 studenata uz spremanje svakih 30 s, a uz 15 s tek na granici bez rezerve. Od 1000 studenata nadalje dio spremanja dobiva 429.
- Ograničenje po korisniku već postoji (spremanje 120 u minuti, ostalo 300, upis 10) i ima rezervu od 30 puta za spremanje svakih 15 s. Zato IP ne treba biti primarna zaštita za prijavljene korisnike, nego samo široki zaštitni prag.
- Prijedlog: faza 1 samo podizanjem vrijednosti kroz postojeće varijable okruženja (bez koda), faza 2 kodom: IP limit samo za promet bez potvrđene sesije i popis fakultetskih raspona iz konfiguracije.

## 1. Sva ograničenja po IP-u

Klijentski IP je adresa socketa; `X-Forwarded-For` se čita samo od proxyja iz `TRUSTED_PROXIES` (`server/traffic/client-ip.ts`). Bez adrese svi dijele jedan bucket.

| Ograničenje                       | Zadano                            | Gdje                                                                       | Što broji                                                                                                                           | Konfigurabilno                                               |
| --------------------------------- | --------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `login_per_ip`                    | 30 u min (bucket 30, 0,5/s)       | `server/traffic/rate-limit.ts`, korak 4 pipelinea                          | `GET`/`HEAD` `auth/login` i `auth/callback`; **oba troše isti bucket**, jedna prijava = 2                                           | `DUCTURA_RATE_LIMIT_LOGIN_PER_IP`                            |
| `enroll_per_ip`                   | 60 u min                          | isto                                                                       | `POST institution/enrollments` (stara ruta; **studentska `POST student/enrollments` je klase `default`**)                           | `DUCTURA_RATE_LIMIT_ENROLL_PER_IP`                           |
| `save_per_ip`                     | 1200 u min (bucket 1200, 20/s)    | isto                                                                       | `POST evidence/commit`                                                                                                              | `DUCTURA_RATE_LIMIT_SAVE_PER_IP`                             |
| `default_per_ip`                  | 3000 u min (bucket 3000, 50/s)    | isto                                                                       | **svaki drugi zahtjev**, i prijavljeni: `evidence/open`, `submission`, čitanja, odjava, javne rute; i svaki neprepoznat oblik staze | `DUCTURA_RATE_LIMIT_DEFAULT_PER_IP`                          |
| Javna provjera potvrde            | 30 u min                          | `server/http/public-verification.ts`, vlastiti limiter uz `default_per_ip` | samo adresa, sesija se ne čita                                                                                                      | konstanta `PUBLIC_VERIFICATION_PER_MINUTE`, nije u okruženju |
| Operatorske staze (`/api/v1/ops`) | prazan popis = nitko ne ograničen | `server/traffic/ip-rules.ts`, korak 3                                      | dopušteni IP rasponi (ne ograničenje brzine, nego popis mreža)                                                                      | postavka mreža; dobar uzor za popis raspona                  |
| `TRUSTED_PROXIES`                 | prazno                            | `client-ip.ts`                                                             | što se uopće smatra „klijentskim IP-om”; ne širi od /8                                                                              | okruženje                                                    |

Vrijednosti su cijeli brojevi 1 do 100 000; izvan toga server ne starta. Svaki proces drži bucket u memoriji (nema dijeljenja između instanci). Odbijen zahtjev ne troši žetone, `Retry-After` je 1 do 60 s.

**Klasifikacija upisa:** `classOf` (`server/traffic/rate-limit.ts`) u klasu `enroll` svrstava samo `POST /api/v1/institution/enrollments`. Ruta `POST /api/v1/student/enrollments` (`student.enrollments.post`, montirana kroz `createStudentWriteRoutesFor`) pada u `default`, pa ima 3000 po IP-u i 300 po računu i operaciji, ne 60 i 10. Varijable `ENROLL_*` je dakle ne mijenjaju.

**Nije po IP-u, ali se ponaša slično:** upis kodom ima i ograničenje po korisniku u bazi (`enrollment_attempt_limit` po ustanovi, `too_many_attempts`); ono je po korisniku i NAT ga ne dira.

**Već po korisniku** (`server/http/rate-limit/index.ts`): prozor od 60 s po paru (operacija, `actor.scope`), samo za rute koje traže sesiju. Zadano 120 (spremanje), 300 (ostalo), 10 (upis, samo stara ruta `institution/enrollments`). Sesije istog računa dijele kvotu.

### Redoslijed i posljedica

IP limiter radi u koraku 4, **prije** nego se zna tko je korisnik. Prijavljeni student dakle prvo prolazi IP bucket svog fakulteta, pa tek onda svoju kvotu. Kad IP bucket pukne, student bez ikakve krivnje dobiva 429, a kvota po korisniku to ne može spriječiti.

### Staging je već u tom stanju

`docs/STAGING.md` navodi da je ispred poslužitelja Vercel čije adrese nisu stalne i ne smiju u `TRUSTED_PROXIES`. Server zato svim korisnicima vidi izlaznu adresu Vercela, pa na stagingu **svi korisnici dijele jedan IP bucket**, ne samo fakultet. Ograničenja po adresi na stagingu su dakle već sada grublja nego u produkciji.

## 2. Što se događa za 300, 1000 i 2000 studenata iza jedne adrese

Model: token bucket, kapacitet jednak granici u minuti, dopuna granica/60 po sekundi. Brojke su izračun iz koda, ne mjerenje.

### 2.1 Spremanje (`save_per_ip`: 1200, 20/s)

**Model ravnomjernog prometa:** zahtjevi su ravnomjerno raspoređeni u vremenu. Stopa je N / T zahtjeva u sekundi (T je razmak spremanja jednog studenta). Dok je stopa iznad 20/s, bucket se prazni brzinom (stopa − 20)/s; nakon toga prolazi samo 20/s, a ostatak dobiva 429.

| Studenata | Razmak spremanja |   Stopa | Ishod                                                              |
| --------: | ---------------: | ------: | ------------------------------------------------------------------ |
|       300 |             30 s |    10/s | Prolazi, rezerva 10/s.                                             |
|       300 |             15 s |    20/s | Točno na granici dopune, **bez rezerve**; svaki nalet daje 429.    |
|      1000 |             30 s |  33,3/s | Bucket prazan nakon **90 s**, zatim prolazi 60 %, 40 % dobiva 429. |
|      1000 |             15 s |  66,7/s | Prazan nakon **26 s**, prolazi 30 %.                               |
|      2000 |             30 s |  66,7/s | Prazan nakon **26 s**, prolazi 30 %.                               |
|      2000 |             15 s | 133,3/s | Prazan nakon **11 s**, prolazi 15 %.                               |

**Sinkronizirani nalet:** studenti koji spremaju istodobno (početak rada, rok, povratak mreže) šalju N zahtjeva odjednom svakih T sekundi. Prolazi samo što stane u bucket, a između naleta se dopuni 20 · T žetona (najviše 1200). Prvo odbijanje je zato ranije nego u modelu iznad.

| Studenata | Razmak | Prvo odbijanje                              | Dugoročno prolazi            |
| --------: | -----: | ------------------------------------------- | ---------------------------- |
|       300 |   15 s | nikad (dopuni se svih 300 između naleta)    | 100 %                        |
|       300 |   30 s | nikad                                       | 100 %                        |
|      1000 |   30 s | drugi nalet, nakon 30 s (odbije se 200)     | 600 od 1000 po naletu (60 %) |
|      1000 |   15 s | drugi nalet, nakon 15 s (odbije se 500)     | 300 od 1000 po naletu (30 %) |
|      2000 |   30 s | **odmah**, prvi nalet: 1200 prolazi, 800 ne | 600 od 2000 (30 %)           |
|      2000 |   15 s | **odmah**, prvi nalet: 1200 prolazi, 800 ne | 300 od 2000 (15 %)           |

Dugoročni udio je isti u oba modela; razlika je u tome kad počinju odbijanja. Za početak nastave i rok vrijedi sinkronizirana tablica.

Ograničenje po korisniku nije problem: 4 spremanja u minuti (svakih 15 s) prema 120 daje rezervu od 30 puta.

ISTR-9 potvrđuje isto: 100 studenata spremanjem svake sekunde iscrpilo bi bucket za oko 15 s (1200 / (100 − 20)).

### 2.2 Prijava na početku nastave (`login_per_ip`: 30, dvije po prijavi)

Početni bucket daje 15 prijava odmah, zatim 0,25 prijava u sekundi (15 u minuti).

| Studenata | Vrijeme da se svi prijave (ako nitko ne odustane) |
| --------: | ------------------------------------------------- |
|       300 | oko 19 min                                        |
|      1000 | oko 66 min                                        |
|      2000 | oko 132 min                                       |

Svaki neuspjeli pokušaj i ponovni klik troši dodatne žetone. U praksi to znači da se nastava ne može početi prijavom cijele predavaonice.

### 2.3 Nalet na početku nastave (`default_per_ip`: 3000, 50/s)

Pretpostavka (nije mjerena): otvaranje aplikacije i rada traži oko 20 zahtjeva klase `default` po studentu (`evidence/open`, čitanja). Stalno stanje: 3 do 10 zahtjeva u minuti po studentu.

| Studenata | Nalet 20 zahtjeva po studentu | Vrijeme da se isprazni red | Stalno stanje, 3/min | Stalno stanje, 10/min |
| --------: | ----------------------------: | -------------------------: | -------------------: | --------------------: |
|       300 |                          6000 |                       60 s |         15/s od 50/s |        50/s (granica) |
|      1000 |                        20 000 |                      340 s |       50/s (granica) |          167/s (3,3×) |
|      2000 |                        40 000 |                      740 s |           100/s (2×) |          333/s (6,7×) |

Preko 3000 u prvih nekoliko sekundi sve preko bucketa je 429 s `Retry-After` od 1 s, pa klijenti ponavljaju sinkronizirano.

### 2.4 Rok predaje

Predaja je `default`, a zadnje spremanje `save`. Pretpostavka: 5 zahtjeva po studentu u zadnjih minutu do dvije (zadnje spremanje, predaja, provjere). 300 studenata je 1500 zahtjeva i stane u 3000. 1000 je 5000 (bucket plus 40 s dopune), 2000 je 10 000 (oko 140 s). Spremanje ide uz to u isti prozor pa vrijedi 2.1. Odbijena predaja nije izgubljena ako klijent ponovi, ali rok može proći dok student čeka 429; to se ne smije dogoditi zbog tuđe aktivnosti.

### 2.5 Što je sigurno, a što nije provjereno

- Sigurno (iz koda): brojke bucketa, da login troši 2 žetona, da `default` hvata i prijavljene, da je IP prije identiteta.
- Pretpostavke: broj zahtjeva po studentu u stalnom stanju i pri otvaranju, razmak spremanja 15 do 30 s (nalog). Treba ih izmjeriti na pravom klijentu.
- Nije provjereno: kako klijentski journal postupa s 429 (ponavlja li s `Retry-After`, što student vidi). Kod `serverSync` je u WEB repou, izvan ovog zadatka. Treba potvrditi da 429 nikad ne gubi spremanje i ne pokazuje „SYNCED”.

## 3. Prijedlog modela

Načelo: **primarno ograničenje je po korisniku**, a po IP-u samo zaštita koja je široka za pravu populaciju iza jednog IP-a.

### 3.1 Primarno: po korisniku

Ostaje što je danas (spremanje 120, ostalo 300, upis 10 u minuti po paru operacija i račun). Brojke imaju rezervu 30 puta za spremanje na 15 s, pa se ne mijenjaju. Prijedlog dodatka samo ako ga mjerenje traži: kvota po sesiji (hash tokena) uz onu po računu; mehanizam postoji (`sessionTokenOf`), ali ga adresni limiter namjerno ne koristi.

### 3.2 Faza 1: samo vrijednosti, bez koda

Podiže se IP prag kroz postojeće varijable (`DUCTURA_RATE_LIMIT_*`), uz ciljnu populaciju 2000 studenata i spremanje svakih 15 s.

| Varijabla               | Zadano | Preporuka | Obrazloženje                                                                                                                                                                                                                   |
| ----------------------- | -----: | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `…_SAVE_PER_IP`         |   1200 |    12 000 | 2000 × 4 spremanja u minuti = 8000, plus 50 % za ponovno slanje nakon prekida veze.                                                                                                                                            |
| `…_DEFAULT_PER_IP`      |   3000 |    60 000 | 2000 × 10 u minuti = 20 000 stalno; nalet 2000 × 20 = 40 000 stane u bucket.                                                                                                                                                   |
| `…_LOGIN_PER_IP`        |     30 |       600 | 2000 studenata uđe za oko 7 minuta (300 prijava u minuti); 300 studenata za 1 minutu. Vidi napomenu niže.                                                                                                                      |
| `…_ENROLL_PER_IP`       |     60 |     1 200 | Početak kolegija: cijela grupa upisuje kod u prvoj minuti; vrijedi samo za staru rutu `institution/enrollments`; studentska ruta je `default` (vidi napomenu niže), a po korisniku je ograničena u bazi (`too_many_attempts`). |
| `…_SAVE_PER_ACCOUNT`    |    120 |       120 | bez promjene                                                                                                                                                                                                                   |
| `…_DEFAULT_PER_ACCOUNT` |    300 |       300 | bez promjene                                                                                                                                                                                                                   |
| `…_ENROLL_PER_ACCOUNT`  |     10 |        10 | bez promjene                                                                                                                                                                                                                   |
| Javna provjera potvrde  |     30 |        30 | namjerno stroga, ne dijeli se; javna ruta bez sesije (stranica `/provjera`). Zasebno razmotriti ako fakultet provjerava skupno.                                                                                                |

**Upis studentskom rutom:** faza 1 (samo varijable) ne može je odvojiti od ostalog prometa jer je klase `default`: tamo vrijedi 60 000 po IP-u i 300 po računu. Odvajanje (npr. preslikavanje `POST /api/v1/student/enrollments` u klasu `enroll` uz 10 po računu) traži promjenu `CLASS_ROUTES` i ide u fazu 2. Do tada je upis zaštićen ograničenjem po korisniku u bazi.

Sve su vrijednosti unutar 1 do 100 000.

**Cijena faze 1:** isti široki prag vrijedi i za nepoznate adrese, pa napadač s jedne adrese smije slati do 1000 zahtjeva u sekundi prije 429. Jedan Node proces to ne treba trpjeti kao jedinu zaštitu. Faza 1 je prihvatljiva samo uz zaštitu na rubu (Render/Vercel/WAF) ili kao most do faze 2. Bez te zaštite pilot s manje od 300 studenata po adresi može ostati na zadanim vrijednostima osim prijave.

**Napomena o prijavi:** `login_per_ip` je jedino ograničenje prije identiteta, pa se ne smije podići bez razmišljanja. Srednji korak: 240 (120 prijava u minuti) za sve adrese; 600 ili više samo za popis fakultetskih raspona (faza 2). Brojanje oba koraka (login i callback) treba odlučiti: ako se broji samo `auth/callback`, vrijednosti se prepolove.

### 3.3 Faza 2: promjena koda (zaseban zadatak)

1. **IP bucket samo za promet bez potvrđene sesije.** Danas IP limiter čeka korak 4, prije sesije. Prijedlog: dva IP bucketa. Strogi (zadano ili niže) broji zahtjeve čiji ishod nije potvrđena sesija (401, javne rute, prijava, upis); široki zaštitni prag (iz faze 1) broji sve. Student s valjanom sesijom troši samo široki prag i svoju kvotu po računu. Lažan kolačić ne pomaže napadaču: ne prođe provjeru sesije pa pada u strogi bucket.
2. **Popis fakultetskih raspona iz konfiguracije** (uzor `parseAllowedNetworks`: CIDR, najviše 16 unosa, ne šire od /8 i /16). Adrese iz popisa dobivaju razinu „fakultet” (npr. `login` 600, ostalo kao u 3.2), sve druge ostaju na strogoj razini. Popis ne ide u zapis ni u odgovor. Ispravan popis zahtijeva da `TRUSTED_PROXIES` točno određuje klijentski IP, inače je raspon neupotrebljiv.
3. **Neuspjeh zatvoren sigurno:** neispravan popis zaustavlja pokretanje (kao `TRUSTED_PROXIES`), prazan popis znači da nema razine „fakultet”.
4. **Mjerenje i zapis:** `traffic.rate_limited` već ima vrstu bucketa (`per_address`, `per_account`); dodati razinu (`address_strict`, `address_wide`) da se vidi koji je prag pukao.
5. **Testovi:** NAT scenarij (2000 korisnika, jedan IP, prolaze svi), napadač s lažnim kolačićem (pada u strogi bucket), granice popisa, bez regresije postojećih testova (`server/traffic/rate-limit*`, `server/http/rate-limit/*`).
6. **Dokumentacija:** `server/traffic/README.md`, `server/http/rate-limit/README.md`, `docs/DEPLOY.md`.

### 3.4 Preporučene vrijednosti za pilot po veličini

| Studenata iza jedne adrese | Spremanje po IP-u | Ostalo po IP-u | Prijava po IP-u (faza 2: raspon fakulteta) |
| -------------------------: | ----------------: | -------------: | -----------------------------------------: |
|                     do 300 |             3 000 |         12 000 |                                        240 |
|                    do 1000 |             6 000 |         30 000 |                                        480 |
|                    do 2000 |            12 000 |         60 000 |                                        600 |

Spremanje: 300 × 4 = 1200 u minuti, 1000 × 4 = 4000, 2000 × 4 = 8000 (svakih 15 s), pa je prag najmanje 2,5× veći. „Ostalo”: nalet od 20 zahtjeva po studentu (6000, 20 000, 40 000), prag je 1,5× do 2× nalet. Prijava: 2 žetona po prijavi, cilj je da se razred prijavi u 1 do 7 minuta.

## 4. Otvoreno i odluke za vlasnika

1. Faza 1 odmah (samo okruženje) ili čekati fazu 2? Preporuka: faza 1 za staging i demo, faza 2 prije pilota s fakultetom.
2. Brojati li oba koraka prijave (login i callback) ili samo callback.
3. Stvarni brojevi zahtjeva po studentu (pretpostavke 2.3 i 2.4) treba izmjeriti u pravom klijentu ili probom kao ISTR-9 s 300 korisnika uz više izvornih adresa.
4. Ponašanje klijenta na 429 (journal, „SYNCED”) provjerava se u WEB repou.
5. Fakultet mora dati raspone izlaznih adresa i potvrditi da je jedan javni IP. Bez toga faza 2 točka 2 nije moguća; uz više adresa (NAT pool) bucketi se raspodijele sami.
6. `TRUSTED_PROXIES` na stagingu (Vercel): dok se ne riješi, ograničenja po IP-u tamo vrijede za sve korisnike skupa.

## 5. Što nije napravljeno

Nijedna konfiguracija ni kod nisu mijenjani, nijedna proba nije pokrenuta, a testovi nisu potrebni jer je promjena samo dokument. Brojke su izračun iz koda (`server/traffic/rate-limit.ts`, `server/http/rate-limit/`), pretpostavke su označene.
