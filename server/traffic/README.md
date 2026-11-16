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

## Tko ga zove

Samo `http`.

## Koje podatke dira

Brojači ograničenja u memoriji. Zapis prometa i sigurnosne događaje piše preko `log` u bazu zapisa, bez tijela zahtjeva, kolačića, tokena i upita iz URL-a.

## Što izvozi

- `TRAFFIC_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `TRAFFIC_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `TrafficService`: tip servisa bez članova (`service.ts`);
- `parseTrustedProxies`, `NO_TRUSTED_PROXIES`, `TrustedProxies`: popis povjerljivih proxyja (`client-ip.ts`);
- `clientIpLayer`: korak 2 pipelinea; `clientIpOf(request)`: IP koji je korak zapisao, za korake 3 do 5 (`client-ip.ts`);
- `parseAllowedNetworks`, `networkAllows`, `isOpsPath`, `NO_ALLOWED_NETWORKS`, `MAX_ALLOWED_NETWORKS`, `MAX_ALLOWED_NETWORKS_LENGTH`, `AllowedNetworks`: IP prava, korak 3 (`ip-rules.ts`);
- `createRateLimiter`, `checkRateLimits`, `DEFAULT_RATE_LIMITS`, `RATE_LIMIT_CLASSES` i tipovi: ograničenje broja zahtjeva, korak 4 (`rate-limit.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log` i `metrics`, i to kroz njihov `index.ts`. Ne uvozi `http`, `database`, `external/*` ni feature područja. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
