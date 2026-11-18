# server/contracts

Ugovor API-ja `/api/v1` (karta: [docs/server-map.md](../../docs/server-map.md)).

## Što radi

Sheme svih ruta u TypeBoxu: validacija ulaza, inventar ruta, OpenAPI (`openapi/v1.json`), vektori uspjeha i greške, provjera nekompatibilnih promjena i lažni server iz vektora.

## Tko ga zove

`roles`, `legal`, `backup`, `deletion`, `downloads` i `http`; klijenti preko generiranog paketa i lažnog servera.

## Koje podatke dira

Ništa; samo sheme.

## Što izvozi

`ROUTES` (sve rute s ugovorom), `INVENTORY`, `SERVER_SOURCES`, `CONTRACT_ONLY` i `checkInventory`, sheme iz `schema/`, `checkVectors`, `breakingChanges`, `API_VERSION`, `FALLBACK`, `INTERNAL` i `SHARED_ERRORS` i pomoćne funkcije za ID rada (`isWorkId`, `workIdFromPath`). Točan popis je u `index.ts`.

## Što ne smije uvoziti

Ništa iz drugih područja; od knjižnica samo `@sinclair/typebox` ([karta servera, §2](../../docs/server-map.md#2-dopušteni-uvozi)).

## WebAuthn, drugi faktor (DAN-840)

`routes/webauthn.ts` (S-1E-g, 840-1): izazov, registracija i potvrda sigurnosnog ključa. Sve tri rute traže postojeću sesiju AAI@EduHr i nisu način prijave (D-09). Podržani su samo ES256 i atestacija `none`. Ključ je COSE ključ iz `authenticatorData`, a tijelo ne može navesti drugi. `challenge_invalid` ne razlikuje nepoznat, iskorišten i istekao izazov. `ceremony_invalid` je kriv origin, rpId, tip, zastavice ili potpis u ceremoniji, a ne zaglavlje `Origin`. `counter_not_increased` je brojač koji nije narastao (0 → 0 se prihvaća). Vektori pokazuju samo odgovor; ponašanje dokazuju 840-2 i 840-3.

## Zajednička greška `internal` (DAN-776)

`INTERNAL` je odgovor bilo koje rute kad rukovatelj padne prije prvog bajta: 500 i tijelo problema `{"error":"internal","code":"internal","messageKey":"errors.internal","status":500,"requestId":"…"}` (S-1L.3, DAN-789). Osim `requestId`, koji server sam napravi, nikad ne nosi poruku, ime, stog ni drugi podatak iz servera. Nalazi se u `SHARED_ERRORS`. Generirani klijent ga prepoznaje na svakoj ruti, ali samo kad ga tijelo navodi. Lažni server ga vraća uz `x-ductura-fake-vector: internal` (vektor u `platform.health.get.json`). `TOO_MANY_REQUESTS` (`429 too_many_requests`, `errors.tooManyRequests`, zaglavlje `Retry-After`) je drugi dijeljeni odgovor: ograničenje broja zahtjeva prije svake rute (S-1C.3, DAN-814). Guard nekompatibilnih promjena ne dopušta novi status pod postojećom rutom ni novo polje u `info` (Ductus#1836 c.6896639138), pa `openapi/v1.json` dijeljene greške objavljuje u `info.description`, po redak za svaku sa statusom, kodom, ključem i zaglavljima (`SHARED_ERROR_HEADERS`); `openapi.test.ts` traži da su sve tamo. Poznata granica: pod rutama ih v1 ne navodi. Statusi, kodovi i ključevi dijeljenih grešaka i kataloga grešaka su podatak u `routes/error-catalog.json` (DAN-928): iz njega `routes/platform.ts` gradi `INTERNAL` i `TOO_MANY_REQUESTS` (učitavanje pada ako ključ nije `messageKeyOf(code)`), `server/http/error-catalog.ts` gradi `ERROR_CATALOG` iz `ERROR_CATALOG_DATA`, a `@ductura/contracts` istu datoteku objavljuje kao `errors/catalog.json`. To je jedini dopušteni uvoz JSON-a (`JSON_IMPORTS` u `scripts/lint-rules/import-boundary.ts`).

## Rute koje se rađaju na serveru i rute bez handlera (DAN-803)

- `SERVER_SOURCES` (`inventory.ts`) su rute kojima Ductus podatak daje izvan `route.ts`, npr. popis radova studenta (`src/components/student/my-assignments-read.ts`). Ključ je `route.ts` koji bi ruta imala, a `checkInventory` ih prihvaća kao datoteke inventara. `INVENTORY` ostaje kopija 38 Ductusovih datoteka.
- `CONTRACT_ONLY` je stanje „ugovoreno, nije implementirano”: ruta ima ugovor i vektore, a klijenti rade nad lažnim serverom. Ruta s popisa izlazi kad se montira njezin handler. Nova ruta na popis ulazi samo s novim zamrznutim popisom zadatka. `tests/contracts/contract-only.test.ts` drži zamrznute popise zadataka:
  - 27 ruta DAN-803;
  - 3 rute postavki DAN-806;
  - 3 rute WebAuthna DAN-840 (opseg Ductus#1836 c.6934850911; montirane od 840-3f1, pa više nisu na popisu);
  - 2 nastavnička čitanja DAN-903;
  - dnevnik pristupa studenta DAN-904;
  - stanje rada po zadatku DAN-989 (`student.assignment-work.get`, handler u 989-2);
  - manifest preuzimanja DAN-931 (`downloads.manifest.get`, handler u DAN-932). Pada ako je na popisu ruta izvan tih popisa, ruta bez ugovora ili ruta montirana u nekom području, te ako ruta s tih popisa s ugovorom i bez handlera nije na popisu (Ductus#1836 c.6905207008, potvrda c.6905290513).

## Manifest preuzimanja (DAN-931)

`routes/downloads.ts` (S-1H.5): javni `GET /api/v1/downloads/manifest`, bez ulaza. Svaki redak ima sustav (`windows`, `macos`; D-296), arhitekturu (`x64`, `arm64`), verziju `major.minor.patch`, adresu i SHA-256 paketa (64 heks znaka, mala slova). Adresa je putanja na istoj adresi (`/preuzimanje/…`, D-306 t. 1) ili `https://` adresa: mjesto paketa se ovdje ne odlučuje. Uzorak adrese pušta samo znakove putanje i upita iz RFC 3986, bez fragmenta, porta, korisnika i obrnute kose crte; putanja ne počinje s `//` ni `?`, nema segmenata `.` i `..` ni `%2e` i `%00`, host nikad nije ime ovog računala ni lokalne mreže (`.localhost`, `.local`, `.internal`, `.home.arpa`; `.invalid`, `.test` i `.example` se nikad ne razrješavaju i ostaju dopušteni zbog sintetičkih podataka), ima najviše 253 znaka, a svaka oznaka najviše 63 i nikad nema `--` na trećem i četvrtom mjestu (rezervirane oznake iz RFC 5891, pa ni punycode `xn--`). Node takvu oznaku prima, a IDNA u pregledniku ili desktop ljusci je odbija. `downloads-manifest.property.test.ts` provjerava da WHATWG URL svaku prihvaćenu adresu otvara na istom hostu i istoj putanji. Najviše četiri retka; da je svaki par sustava i arhitekture najviše jednom, shema ne može izraziti, pa to provjerava test nad vektorima, a provodi handler (DAN-932). `server/downloads` je prazan dok handler ne dođe.

## Operatorske rute (DAN-842-2)

Operatorska ruta se izjavljuje dvaput: staza je `/api/v1/ops` ili ispod nje (to čita korak 8 pipelinea, `isOpsPath`), a id je u području `ops` (`ops.<ime>.<metoda>`). Jedno bez drugoga ruši `tests/contracts/operator-routes.test.ts` (S-1J.2, ugovor Ductus#1836 c.6947114430). Da nijedna montirana ruta ne zaobilazi korak 8 provjerava `server/operator-routes.integration.test.ts` (3. krug na ductura/server#245) bez čitanja izvornog teksta: u procesu pokreće stvarni `server/server.ts` i provjerava sljedeće:

- pokretanje sluša točno jednom;
- zabilježeni slojevi su točno koraci pipelinea;
- svaka montirana ruta koja je operatorska po id-u ili po stazi na pokrenutom poslužitelju bez kolačića dobiva 401 koraka 8.

Poslužitelj pokrenut tek nakon pokretanja (na zahtjev ili timer) brojač ne vidi. Test provodi samo izjavu rute: ruta izvan `/api/v1/ops` koja mijenja operatorske razine (npr. `settings.values.put`) nije operatorska ruta u tom smislu i nju štiti baza.

## Zaglavlja zahtjeva (DAN-930-1a)

`RequestSpec.headers` je zatvoren objekt zaglavlja koja klijent mora sam postaviti, a ugovor ih ne izražava drugdje. Imena su malim slovima i sva su obvezna. Shema se provjerava samo nad tim imenima, nikad nad cijelim zahtjevom: `content-type` je u `contentType`, a kolačić i `sec-fetch-site` dodaje preglednik. Izjavljuju ih rute zaštite dokaza (`evidence.open.post`, `evidence.commit.post`, `evidence.replay.post`, `submission.submit.post`: `origin` i `ductus-protocol`) i `live.document.get` (`ductus-protocol`). Shema `origin` prihvaća točno kanonske http(s) origine (`new URL(v).origin === v`), tj. skup koji server prima kao `APP_ORIGIN`: host od znakova koje WHATWG zadržava u domeni (i s praznim oznakama i točkom na kraju), osim kad je zadnja oznaka prije jedne završne točke broj (same znamenke ili `0x` heksadecimalno), što smije biti samo IPv4 s četiri okteta; ili IPv6 literal malim slovima; port 0-65535 bez vodeće nule i bez zadanog porta sheme. Isti origin i dalje provjerava server usporedbom niza. `request-headers.test.ts` drži točan popis ruta, imena i točan skup vrijednosti `ductus-protocol`, zatvorenost, obveznost svakog imena i usklađenost s vektorima: vektor 426 i vektor bez izjavljenog zaglavlja shema odbija, ostale prihvaća.

Poznate granice: generator i generirani klijent ih još ne čitaju (DAN-930-1b), pa se `generated/` ne mijenja; `openapi/v1.json` ih ne objavljuje, jer guard v1 i neobavezan novi parametar broji kao lomljivu promjenu; ostale rute sa zaštitom mutacije (npr. `live.document.put`) ne izjavljuju `origin` i oslanjaju se na preglednik; unutrašnjost IPv6 literala shema ne provjerava; valjanost IDNA oznaka (`xn--`) shema ne provjerava (Node ih ne odbija); skup vrijednosti `ductus-protocol` test drži kao prijepis serverovih popisa, jer `contracts` ne smije uvoziti `http`.
