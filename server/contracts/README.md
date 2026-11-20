# server/contracts

Ugovor API-ja `/api/v1` (karta: [docs/server-map.md](../../docs/server-map.md)).

## Što radi

Sheme svih ruta u TypeBoxu: validacija ulaza, inventar ruta, OpenAPI (`openapi/v1.json`), vektori uspjeha i greške, provjera nekompatibilnih promjena i lažni server iz vektora.

## Tko ga zove

`roles`, `legal`, `backup`, `deletion`, `downloads` i `http`; klijenti preko generiranog paketa i lažnog servera.

## Koje podatke dira

Ništa; samo sheme.

## Što izvozi

`ROUTES` (sve rute s ugovorom), `SIGN_IN_FAILURE`, `INVENTORY`, `SERVER_SOURCES`, `CONTRACT_ONLY` i `checkInventory`, sheme iz `schema/`, `checkVectors`, `breakingChanges`, `API_VERSION`, `FALLBACK`, `INTERNAL` i `SHARED_ERRORS` i pomoćne funkcije za ID rada (`isWorkId`, `workIdFromPath`). Točan popis je u `index.ts`.

## Što ne smije uvoziti

Ništa iz drugih područja; od knjižnica samo `@sinclair/typebox` ([karta servera, §2](../../docs/server-map.md#2-dopušteni-uvozi)).

## WebAuthn, drugi faktor (DAN-840)

`routes/webauthn.ts` (S-1E-g, 840-1): izazov, registracija i potvrda sigurnosnog ključa. Sve tri rute traže postojeću sesiju AAI@EduHr i nisu način prijave (D-09). Podržani su samo ES256 i atestacija `none`. Ključ je COSE ključ iz `authenticatorData`, a tijelo ne može navesti drugi. `challenge_invalid` ne razlikuje nepoznat, iskorišten i istekao izazov. `ceremony_invalid` je kriv origin, rpId, tip, zastavice ili potpis u ceremoniji, a ne zaglavlje `Origin`. `counter_not_increased` je brojač koji nije narastao (0 → 0 se prihvaća). Vektori pokazuju samo odgovor; ponašanje dokazuju 840-2 i 840-3.

## Neuspjela prijava (DAN-1081)

`routes/sign-in-failure.json` kaže kamo vodi neuspjela prijava. Odredište je 303 na `page` (`/prijava`) s parametrom `param` (`greska`) i jednom oznakom iz `codes`; oznake su točno dvije i svaka ima ključ teksta u `locales/`:

- `login_failed` → `auth.failedBody`;
- `provider_unavailable` → `auth.unavailableBody`.

`routes/auth.ts` je čita strogo (`readSignInFailure`): višak ključa, treća oznaka ili drugi redoslijed ruše učitavanje. Izvozi je kao `SIGN_IN_FAILURE`, a `@ductura/contracts` je objavljuje kao `auth/sign-in-failure.json`. To je drugi dopušteni uvoz JSON-a (`JSON_IMPORTS`).

Ovaj dio samo izjavljuje odredište. Tok prijave ga šalje od DAN-1081-Sb.

## Zajednička greška `internal` (DAN-776)

`INTERNAL` je odgovor bilo koje rute kad rukovatelj padne prije prvog bajta: 500 i tijelo problema `{"error":"internal","code":"internal","messageKey":"errors.internal","status":500,"requestId":"…"}` (S-1L.3, DAN-789). Osim `requestId`, koji server sam napravi, nikad ne nosi poruku, ime, stog ni drugi podatak iz servera. Nalazi se u `SHARED_ERRORS`. Generirani klijent ga prepoznaje na svakoj ruti, ali samo kad ga tijelo navodi. Lažni server ga vraća uz `x-ductura-fake-vector: internal` (vektor u `platform.health.get.json`). `TOO_MANY_REQUESTS` (`429 too_many_requests`, `errors.tooManyRequests`, zaglavlje `Retry-After`) je drugi dijeljeni odgovor: ograničenje broja zahtjeva prije svake rute (S-1C.3, DAN-814). Guard nekompatibilnih promjena ne dopušta novi status pod postojećom rutom ni novo polje u `info` (Ductus#1836 c.6896639138), pa `openapi/v1.json` dijeljene greške objavljuje u `info.description`, po redak za svaku sa statusom, kodom, ključem i zaglavljima (`SHARED_ERROR_HEADERS`); `openapi.test.ts` traži da su sve tamo. Poznata granica: pod rutama ih v1 ne navodi. Statusi, kodovi i ključevi dijeljenih grešaka i kataloga grešaka su podatak u `routes/error-catalog.json` (DAN-928): iz njega `routes/platform.ts` gradi `INTERNAL` i `TOO_MANY_REQUESTS` (učitavanje pada ako ključ nije `messageKeyOf(code)`), `server/http/error-catalog.ts` gradi `ERROR_CATALOG` iz `ERROR_CATALOG_DATA`, a `@ductura/contracts` istu datoteku objavljuje kao `errors/catalog.json`. To je dopušteni uvoz JSON-a (`JSON_IMPORTS` u `scripts/lint-rules/import-boundary.ts`), uz `sign-in-failure.json`.

## Rute koje se rađaju na serveru i rute bez handlera (DAN-803)

- `SERVER_SOURCES` (`inventory.ts`) su rute kojima Ductus podatak daje izvan `route.ts`, npr. popis radova studenta (`src/components/student/my-assignments-read.ts`). Ključ je `route.ts` koji bi ruta imala, a `checkInventory` ih prihvaća kao datoteke inventara. `INVENTORY` ostaje kopija 38 Ductusovih datoteka.
- `CONTRACT_ONLY` je stanje „ugovoreno, nije implementirano”: ruta ima ugovor i vektore, a klijenti rade nad lažnim serverom. Ruta s popisa izlazi kad se montira njezin handler. Nova ruta na popis ulazi samo s novim zamrznutim popisom zadatka. `tests/contracts/contract-only.test.ts` drži zamrznute popise zadataka:
  - 27 ruta DAN-803;
  - 3 rute postavki DAN-806;
  - 3 rute WebAuthna DAN-840 (opseg Ductus#1836 c.6934850911; montirane od 840-3f1, pa više nisu na popisu);
  - 2 nastavnička čitanja DAN-903;
  - dnevnik pristupa studenta DAN-904;
  - stanje rada po zadatku DAN-989 (`student.assignment-work.get`, handler u 989-2);
  - manifest preuzimanja DAN-931 (`downloads.manifest.get`; handler je montiran u DAN-932, pa ruta više nije na popisu);
  - operatorsko čitanje događaja DAN-843-1 (`ops.events.get`, handler u 843-2). Pada ako je na popisu ruta izvan tih popisa, ruta bez ugovora ili ruta montirana u nekom području, te ako ruta s tih popisa s ugovorom i bez handlera nije na popisu (Ductus#1836 c.6905207008, potvrda c.6905290513).

## Manifest preuzimanja (DAN-931)

`routes/downloads.ts` (S-1H.5): javni `GET /api/v1/downloads/manifest`, bez ulaza. Svaki redak ima sustav (`windows`, `macos`; D-296), arhitekturu (`x64`, `arm64`), verziju `major.minor.patch`, adresu i SHA-256 paketa (64 heks znaka, mala slova). Adresa je putanja na istoj adresi (`/preuzimanje/…`, D-306 t. 1) ili `https://` adresa: mjesto paketa se ovdje ne odlučuje. Uzorak adrese pušta samo znakove putanje i upita iz RFC 3986, bez fragmenta, porta, korisnika i obrnute kose crte; putanja ne počinje s `//` ni `?`, nema segmenata `.` i `..` ni `%2e` i `%00`, host nikad nije ime ovog računala ni lokalne mreže (`.localhost`, `.local`, `.internal`, `.home.arpa`; `.invalid`, `.test` i `.example` se nikad ne razrješavaju i ostaju dopušteni zbog sintetičkih podataka), ima najviše 253 znaka, a svaka oznaka najviše 63 i nikad nema `--` na trećem i četvrtom mjestu (rezervirane oznake iz RFC 5891, pa ni punycode `xn--`). Node takvu oznaku prima, a IDNA u pregledniku ili desktop ljusci je odbija. `downloads-manifest.property.test.ts` provjerava da WHATWG URL svaku prihvaćenu adresu otvara na istom hostu i istoj putanji. Najviše četiri retka; da je svaki par sustava i arhitekture najviše jednom, shema ne može izraziti, pa to provjerava test nad vektorima, a provodi servis `server/downloads` (DAN-932).

## Operatorske rute (DAN-842-2)

Operatorska ruta se izjavljuje dvaput: staza je `/api/v1/ops` ili ispod nje (to čita korak 8 pipelinea, `isOpsPath`), a id je u području `ops` (`ops.<ime>.<metoda>`). Jedno bez drugoga ruši `tests/contracts/operator-routes.test.ts` (S-1J.2, ugovor Ductus#1836 c.6947114430). Da nijedna montirana ruta ne zaobilazi korak 8 provjerava `server/operator-routes.integration.test.ts` (3. krug na ductura/server#245) bez čitanja izvornog teksta: u procesu pokreće stvarni `server/server.ts` i provjerava sljedeće:

- pokretanje sluša točno jednom;
- zabilježeni slojevi su točno koraci pipelinea;
- svaka montirana ruta koja je operatorska po id-u ili po stazi na pokrenutom poslužitelju bez kolačića dobiva 401 koraka 8.

Poslužitelj pokrenut tek nakon pokretanja (na zahtjev ili timer) brojač ne vidi. Test provodi samo izjavu rute: ruta izvan `/api/v1/ops` koja mijenja operatorske razine (npr. `settings.values.put`) nije operatorska ruta u tom smislu i nju štiti baza.

## Operatorsko čitanje događaja (DAN-843-1)

`routes/ops.ts` (S-1K.5-b): `GET /api/v1/ops/events?from=…&to=…[&after=…]` nad funkcijom `public.operator_log` baze zapisa (S-1K.5-a, DAN-835-1; funkcija, ne pogled, jer čita prozor). Funkcija maskira svaki zapis: adresa ostaje samo kao mreža. Dio računala uvijek se reže, a maska duža od /24 (IPv4) ili /48 (IPv6) skraćuje se na nju. Kraća maska ostaje (npr. `10.0.0.0/8`, pgTAP `db/logs/tests/040-operator-log.sql`, slučaj 3). Polje čije ime ne počinje ASCII slovom iza kojeg su samo ASCII slova i znamenke, ili koje u bilo kojem obliku slova sadrži `token`, `cookie`, `secret`, `password`, `credential`, `bearer`, `authorization` ili `session` ne izlazi, pa ga ni shema ne prima (review na #328, b6edc3e). Prozor je poluotvoren `[from, to)`, najviše 24 sata (točno 24 dopušteno). Stranica ima najviše 1000 događaja, poredanih po `seq`; `next` je `seq` zadnjeg događaja pune stranice, inače `null`. Shema to veže uz duljinu: stranica od najviše 999 događaja ima `next: null`, a stranica od točno 1000 broj. Shema provjerava oblik:

- `from` i `to` su stvarni UTC trenuci kalendara (kao `student.access-log.get`);
- `after` je broj od 0 do 2^53−1 bez vodeće nule (uzorak znamenku po znamenku, provjeren proročištem);
- `kind` je kao provjera `log_entry_kind_shape`;
- `fields` je zatvoren rječnik skalarnih vrijednosti (`additionalProperties: false`, jer ga TypeBox inače ne zatvara), s imenima koja `operator_log` zadržava; `ops-events.test.ts` pravilo čita iz same migracije i uspoređuje ga sa shemom na više od 100 imena.

Svaki uzorak je samo ASCII (`[0-9]`, nikad `\d`, ni u klasi) i završava s `(?![\s\S])`. `ops-events.test.ts` provjerava i to, uz svaki dan od 1999. do 2032. i rubove kalendara iz QA #256. Ostalo kaže sažetak, a provodi handler u 843-2: `from` < `to`, granica od 24 h, 422 za ponovljen ili nepoznat parametar i 503 za cijelu stranicu zbog jednog neprovjerenog retka. `access` je `signed_in`, jer `ACCESS` još nema `operator`. Pristup odlučuje pipeline: korak 3 (mreža) i korak 8 (živa sesija, serverski popis operatora i potvrđen drugi faktor, tim redom; DAN-1092-1). Kad korak 8 ne može pitati popis operatora ili drugi faktor, vraća 503, pa vektor `unavailable` daje i on, ne samo handler.

Vektori su zahtjevi i odgovori koje stvarni server može dati (DAN-843-1b, Ductus#2028 c.6981773723). `tests/contracts/ops-events-step-8.test.ts` provjerava sljedeće:

- svaki vektor prolazi stvarni korak 8, a oba porta dobivaju token koji `server/session` čita iz kolačića; `newSessionToken` iz tih 32 bajta kao slučajnosti daje upravo taj token;
- 401, 403 i 503 tijela su ona koja korak 8 piše;
- svaki redak vektora `page` je zapis koji katalog zapisa propušta, maskiran kao u `operator_log`, a `seq` stranice ide bez rupa, jer lanac zapisa ne preskače `seq` (rupu može dati samo pomak sata baze unatrag, koji vektor nema);
- redak `traffic.request` je ono što piše `createTrafficRecorder` (`anonymous`, `not_checked`, `requestId` kao UUID v4);
- ostali retci (`authz.operator_denied`, `traffic.ip_denied`) su ono što stvarni koraci 3 i 8 iz `createLayers` zapišu kroz `createOperatorDenialLog` za zahtjev retka `traffic.request` s istim `requestId`, i to sa statusom tog retka. Retci prijave (`authn.login_*`) više nisu u vektoru, jer ih nijedan proizvođač ovog servera ne piše u zapis;
- prozor svakog vektora osim 422 je onaj koji `operator_log` čita: `from` prije `to`, najviše 24 sata;
- status retka `traffic.request` je onaj koji ruta može dati: izjavljeni za tu metodu ili 405 za metodu koju nijedna ruta na stazi nema, 404 za rutu `none`, 429, 499 i 500 svugdje, 401, 403 i 503 samo na operatorskoj stazi (`isOpsPath`) te 403 koraka 7 samo gdje ga stvarni sloj porijekla daje (ne na ruti pružatelja identiteta). Model je server s montiranom ovom rutom (843-2); ostale rute iz `CONTRACT_ONLY` router nema, pa npr. `GET /api/v1/settings/values` daje 405. Provjera ide za svaku rutu iz `inventory.ts`.

TS preslika maske provjerava se na svih 14 slučajeva pgTAP 040. Poznata granica: uzorak `requestId` u tijelima grešaka je zajednički `REQUEST_ID_PATTERN` i završava s `$` (DAN-1098). Test uzoraka ga izuzima samo po točnom tekstu.
