# server/traffic

Područje iz [karte servera](../../docs/server-map.md). Ima IP klijenta (S-1C.1, DAN-790); IP prava, ograničenje i zapis prometa dolaze u valu 5.

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

## Tko ga zove

Samo `http`.

## Koje podatke dira

Brojači ograničenja u memoriji. Zapis prometa i sigurnosne događaje piše preko `log` u bazu zapisa, bez tijela zahtjeva, kolačića, tokena i upita iz URL-a.

## Što izvozi

- `TRAFFIC_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `TRAFFIC_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `TrafficService`: tip servisa bez članova (`service.ts`);
- `parseTrustedProxies`, `NO_TRUSTED_PROXIES`, `TrustedProxies`: popis povjerljivih proxyja (`client-ip.ts`);
- `clientIpLayer`: korak 2 pipelinea; `clientIpOf(request)`: IP koji je korak zapisao, za korake 3 do 5 (`client-ip.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log` i `metrics`, i to kroz njihov `index.ts`. Ne uvozi `http`, `database`, `external/*` ni feature područja. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
