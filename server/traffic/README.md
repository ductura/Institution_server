# server/traffic

Područje iz [karte servera](../../docs/server-map.md). Ima IP klijenta (S-1C.1, DAN-790), IP prava za operatorske staze (S-1C.2, DAN-832-1) i ograničenje broja zahtjeva (S-1C.3, DAN-814); zapis prometa dolazi u valu 5.

## Što radi

IP klijenta, IP prava, ograničenje broja zahtjeva i zapis prometa: koraci 2 do 5 toka zahtjeva iz karte. Ograničenje broji zahtjeve po IP-u i po hashu sirovog kolačića sesije; sesiju ne razrješava.

IP klijenta (`client-ip.ts`, ugovor Ductus#1836 c.6900102277):

- Izravna adresa je adresa socketa. `X-Forwarded-For` čita se samo kad je ona na popisu `TRUSTED_PROXIES`; prazan popis (zadano) znači da se zaglavlje nikad ne čita. `Forwarded`, `X-Real-IP` i slična zaglavlja nikad se ne čitaju.
- Unosi zaglavlja (sve pojave, redom) obilaze se zdesna; prvi ispravan nepovjerljiv unos je klijent. Neispravan unos ili više od 32 obiđena unosa: najbliži povjerljivi skok desno. Svi unosi povjerljivi: najljeviji unos.
- Unos je IPv4, IPv6, `IPv4:port`, `[IPv6]` ili `[IPv6]:port`, uz razmake i tabove oko njega. Zone ID, vodeće nule, heks, oktalni i skraćeni IPv4 su neispravni.
- Adrese se uspoređuju kao brojevi (32 ili 128 bita); IPv4-mapped IPv6 je ista IPv4 adresa. IPv6 se zapisuje prema RFC 5952.
- `TRUSTED_PROXIES` su adrese i CIDR rasponi odvojeni zarezom, najviše 64. Neispravan unos, prazan unos, raspon širi od /8 (IPv4) ili /16 (IPv6), uključujući `/0`, i postavljeni bitovi domaćina zaustavljaju pokretanje. IPv4 raspon napisan kao IPv4-compatible IPv6 (`::192.0.2.0/120`) je IPv6 raspon i ne pokriva IPv4 adrese.
- Pravilo pretpostavlja da svaki povjerljivi proxy dodaje izravnu adresu na kraj `X-Forwarded-For`. Proxy koji zaglavlje prosljeđuje nepromijenjeno ne smije biti na popisu, jer bi klijent iza njega mogao lažirati adresu.
- Unos dulji od 53 znaka (nakon skidanja razmaka) je neispravan i ne čita se.
- Sloj nikad ne odbija ni ne baca. Bez adrese socketa IP je `null`. Nijedna vrijednost zaglavlja ne ide u zapis.

IP prava (`ip-rules.ts`, ugovor Ductus#1836, DAN-832-1):

- Popis dopuštenih mreža vrijedi samo za operatorske staze: `/api/v1/ops` i sve ispod. Staza se čita šire od routera: bez sheme i hosta apsolutnog cilja, bez upita i `#`, bez obzira na velika slova i s nizom `/` kao jednim. Ostale staze pravilo ne gleda.
- Prazan popis (zadano) ne ograničava nikoga. Inače prolazi samo IP iz koraka 2 (`clientIpOf`) koji je u popisu; zahtjev bez IP-a ne prolazi. `X-Forwarded-For` se ovdje ne čita.
- Popis je string: adrese i CIDR rasponi odvojeni zarezom, s ograničenjima kao `TRUSTED_PROXIES` (bez bitova domaćina, ne šire od /8 i /16), oko unosa samo razmaci, najviše 16 unosa i 256 znakova. Svaki drugi znak (tab, CR, LF, NBSP, DEL, `%`, zagrade, port), prazan unos ili ne-string daje `null`.
- Odluku donosi samo popis koji je napravio `parseAllowedNetworks`; drugo polje ne propušta nikoga. Odbijanje (403 `forbidden`) piše `http`.

Ograničenje broja zahtjeva (`rate-limit.ts`, ugovor Ductus#1836 c.6908215789, plan napada ductura/server#117):

- Token bucket po IP-u (iz `clientIpOf`; bez adrese jedan zajednički bucket) i po korisniku (SHA-256 tokena sesije; sesija se ne razrješava). Token čita funkcija `sessionTokenOf` koju daje `http` (`sessionTokenFromCookie` iz `session`), pa limiter i sesija uvijek čitaju isti kolačić. Bez tokena (ili kad funkcija baci) samo bucket po IP-u.
- Razredi: `login` (`GET`/`HEAD` `/api/v1/auth/login` i `/api/v1/auth/callback`; samo po IP-u), `enroll` (ruta se prenosi kasnije), `save` (`POST /api/v1/evidence/commit`) i `default`. Razred je iz metode i točne staze bez upita; svaki drugi oblik staze je `default`.
- Granica je broj zahtjeva u minuti: bucket ih drži toliko i dopunjuje ih kroz minutu. Zadano (`DEFAULT_RATE_LIMITS`, katalog postavki S-1J-f): login 30 po IP-u; upis 60 po IP-u i 10 po korisniku; spremanje 1200 i 120; ostalo 3000 i 300. Granica izvan 1 do 100 000 zaustavlja pokretanje.
- Zahtjev prolazi samo kad svaki bucket koji dira ima token, i tek tada se tokeni uzimaju: odbijen zahtjev ne troši ništa. `retryAfter` su cijele sekunde (1 do 60) do trenutka kad svi kratki bucketi imaju token, pa ponovljeni zahtjev nakon njega prolazi.
- Sat se ubrizgava; sat koji ide unatrag ne dodaje tokene. Najviše 50 000 bucketa ukupno; preko toga odlazi najdulje nekorišten (i odbijen zahtjev računa se kao korištenje).
- Odluka nosi samo razred, vrstu bucketa i `retryAfter`, nikad IP, kolačić ni hash. 429 i zapis `traffic.rate_limited` piše `http` (DAN-814 b).

Zapis prometa (`traffic-record.ts`, ugovor Ductus#1836 c.6919128457, dodatak c.6925832235; DAN-831-2):

- `createTrafficRecorder` daje `arm(request, response)`: jedan zapis `traffic.request` po odgovoru, kad se odgovor zatvori (`close`); ako je već zatvoren, odmah. Drugi `arm` za isti odgovor ne radi ništa, ni iz drugog snimača.
- Zapis nosi metodu (izvan `TRAFFIC_METHODS` je `OTHER`), predložak rute koji daje pozivatelj ili `none`, IP iz koraka 2 ili `none`, poslani status (`499` kad zaglavlja nisu poslana), trajanje od `arm` do zatvaranja (cijeli ms, 0 do 86 400 000) i vrstu računa `anonymous`. Tijelo, zaglavlja, kolačić i upit se ne čitaju.
- `routeOf` i `requestIdOf` daje `http` (ovo područje ga ne uvozi); `requestIdOf` se zove tek pri zatvaranju, pa uspješan odgovor ne dobiva `X-Request-Id`. Sat se ubrizgava.
- Snimač nikad ne baca i ne čeka zapisnik. Status izvan 100 do 599 katalog odbija (rezervni redak); ovaj server takve ne šalje. Uključivanje u pipeline je DAN-831-3.

Izvor metrike iz zapisa prometa (`traffic-tally.ts`, DAN-834-3, ugovor Ductus#1836 c.6930660055):

- `createTrafficTally` daje `observe(zapis)` i `take()`. `observe` prima isti ulaz koji snimač predaje `write` i čita samo `event`, `fields.status` i `fields.durationMs`, i to samo kao vlastita podatkovna svojstva: getter se ne poziva, naslijeđeni ključ i `__proto__` se ne čitaju, niz se preskače, a `observe` nikad ne baca. IP, `requestId`, ruta i ostala polja ne stižu do uzorka.
- Broji se samo `traffic.request` sa statusom 100 do 599 i trajanjem 0 do `MAX_DURATION_MS`, kao u katalogu. Greška je status 500 i više; `499` je zahtjev, ali nije greška.
- `take()` vraća tri zamrznuta uzorka (`request_count`, `error_count`, `latency_p95_ms`) samo s `metric` i `value` i prazni prozor. p95 je gornja granica košare iz `LATENCY_BUCKETS_MS` u kojoj je rang ⌈0,95 · n⌉, pa memorija ne raste s prometom. Spajanje sa sakupljačem iz `metrics` radi sastavljač (DAN-834).

Zbrojevi prometa (`traffic-summary.ts`, DAN-836-1, ugovor Ductus#1836):

- `createTrafficSummary({ now })` daje `observe(zapis)` i `summarize(windowMinutes)` za operatorsku rutu `GET /api/v1/ops/traffic` (DAN-836-2). `observe` čita samo `event`, `fields.route` i `fields.status`, kao vlastita podatkovna svojstva (kao `traffic-tally`), i nikad ne baca. IP, `requestId` i ostala polja ne stižu do zbroja.
- Broji se samo `traffic.request` sa statusom 100 do 599 i rutom `none` ili predloškom iz kataloga zapisa (`/api/v1` i najviše 10 segmenata). Zapis ide u minutu sata u trenutku `observe`; sat koji baca ili ne daje konačan broj ne broji ništa.
- `summarize` vraća `{ ok, value: { windowMinutes, total, rows: [{ route, status, count }] } }` za minute `(sada − windowMinutes, sada]`; minuta poslije sata (sat je išao unatrag) ne ulazi. Prozor je cijeli broj minuta od 1 do `MAX_WINDOW_MINUTES` (1440); veći broj daje `TRAFFIC_WINDOW_TOO_LARGE`, sve ostalo `TRAFFIC_WINDOW_INVALID` (tekstovi `trafficSummary.*` u `locales/hr.json`).
- Čuva se najviše 1440 minuta i ukupno `MAX_ENTRIES` (50 000) parova (minuta, ruta, status); novi par preko toga se ne broji, poznati se broji dalje.

## Tko ga zove

Samo `http`.

## Koje podatke dira

Brojači ograničenja, brojači metrike prometa i zbrojevi prometa po minuti u memoriji. Zapis prometa i sigurnosne događaje piše preko `log` u bazu zapisa, bez tijela zahtjeva, kolačića, tokena i upita iz URL-a.

## Što izvozi

- `TRAFFIC_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `TRAFFIC_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `TrafficService`: tip servisa bez članova (`service.ts`);
- `parseTrustedProxies`, `NO_TRUSTED_PROXIES`, `TrustedProxies`: popis povjerljivih proxyja (`client-ip.ts`);
- `clientIpLayer`: korak 2 pipelinea; `clientIpOf(request)`: IP koji je korak zapisao, za korake 3 do 5 (`client-ip.ts`);
- `createTrafficRecorder`, `TRAFFIC_METHODS`, `STATUS_CLOSED_EARLY`, `MAX_DURATION_MS` i tipovi: zapis prometa, korak 5 (`traffic-record.ts`);
- `createTrafficTally` i tipovi `TrafficTally`, `TrafficSample`, `TrafficMetric`: izvor metrike iz zapisa prometa (`traffic-tally.ts`);
- `createTrafficSummary`, `MAX_WINDOW_MINUTES`, `MAX_ENTRIES`, `TRAFFIC_SUMMARY_ERROR_CODES` i tipovi: zbrojevi prometa po ruti, statusu i prozoru (`traffic-summary.ts`);
- `parseAllowedNetworks`, `networkAllows`, `isOpsPath`, `NO_ALLOWED_NETWORKS`, `MAX_ALLOWED_NETWORKS`, `MAX_ALLOWED_NETWORKS_LENGTH`, `AllowedNetworks`: IP prava, korak 3 (`ip-rules.ts`);
- `createRateLimiter`, `checkRateLimits`, `DEFAULT_RATE_LIMITS`, `RATE_LIMIT_CLASSES` i tipovi: ograničenje broja zahtjeva, korak 4 (`rate-limit.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log` i `metrics`, i to kroz njihov `index.ts`. Ne uvozi `http`, `database`, `external/*` ni feature područja. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
