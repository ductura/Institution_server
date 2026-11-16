# server/log/events

Katalog događaja područja `log` (S-1K.1, DAN-796; [karta servera](../../../docs/server-map.md)). Samo katalog i provjera; servis koji zapise piše u bazu zapisa je S-1K.3-a.

## Što radi

Zatvoren popis vrsta događaja (`EVENT_CATALOG`) i provjera zapisa (`checkEvent`). Svaki zapis ima točno pet ključeva: `time` (ISO vrijeme u UTC-u s milisekundama), `event` (vrsta iz kataloga), `requestId` (UUID v4 malim slovima, kao `server/http/request-id.ts`), `accountKind` (jedna od pet vrsta računa ili `anonymous`) i `fields`.

- Područja: prijava (`authn`), sesija i kolačići (`session`), ovlasti (`authz`), promet (`traffic`), vanjski servisi (`external`), radnje vrsta 3–5 (`admin`), metrika (`metrics`), kontekst klijenta (`client`), pravni tekstovi (`legal`), backup (`backup`), brisanje (`deletion`), upozorenja (`warning`) i neočekivane greške (`error`).
- Svaka vrsta ima popis dopuštenih vrsta računa (`actors`) i zatvorena polja. Polje je kod iz popisa, ograničen cijeli broj, zastavica, UUID, verzija `x.y.z` ili predložak rute koji mora biti u inventaru ruta predanom provjeri. Vrste polja za slobodni tekst nema, pa tekst rada ni osobni podatak nemaju polje kroz koje bi prošli.
- Odbija se: nepoznata vrsta (točan zapis, bez rezanja razmaka i promjene velikih slova; `__proto__` i nasljeđena imena nisu vrste), vrsta računa koja nije na popisu događaja, višak ili manjak ključa ili polja, ugniježđeni objekt, getter, simbolni ključ, Proxy, instanca klase. Greška ima oblik `{ code, messageKey }` (`docs/CODE_STYLE.md` §8; tekst je u `locales/hr.json` pod `logCatalog`) i nikad ne nosi odbijenu vrijednost.
- Rezultat je nova zamrznuta kopija s provjerenim vrijednostima; katalog je zamrznut do dna, pa ga uvoznik ne može proširiti.
- Inventar ruta predaje se kao pravi `Set` predložaka u obliku iz `server/contracts`, s parametrima kao `{documentId}`, nikad stvarnih putanja zahtjeva; provjera zove `Set.prototype.has`. Bez inventara nijedna ruta ne prolazi, a neispravne opcije daju `BAD_OPTIONS`. `checkEvent` nikad ne baca.
- Jedina iznimka za ID osobe: `admin.action` nosi `userId` operatora (UUID računa, bez imena, e-pošte i IP-a), samo za vrste 3–5 (S-1J.4, DAN-841; odluka vlasnika Ductus#2012 c.6917729838). Rok čuvanja i brisanje po roku su zaseban zadatak.
- Poznata granica: brojčana polja, UUID i verzija mogu nositi nekoliko bajtova proizvoljnih znamenki, ali ne čitljiv tekst.
- Pozadinski posao bez prijavljene osobe (raspored backupa, brisanje po roku, metrika, upozorenja) bilježi se kao `anonymous`.

## Tko ga zove

Servis zapisa `server/log/writer.ts` (S-1K.3-a, DAN-807) prije spremanja; područja zapise pišu kroz njega. Događaje sesije (`session.*`) slaže `server/session/events.ts` (DAN-830) iz stanja sesije; razlozi `session.revoked` uključuju sve razloge zatvaranja iz `identity.session`.

## Koje podatke dira

Nijedne; čista provjera bez ulaza i izlaza.

## Što izvozi

`EVENT_CATALOG`, `EVENT_KINDS`, `CATALOG_ERROR_CODES`, `catalogMessageKey`, `checkEvent`, `isEventKind`, `LOG_ACCOUNT_KINDS`, `LOG_ACTORS`, `LOG_ACTIONS`, `ADMIN_LOG_ACTIONS` i tipove `EventKind`, `EventSpec`, `FieldSpec`, `LogActor`, `LogRecord`, `CatalogResult`, `CatalogErrorCode`, `CheckOptions`.

## Što ne smije uvoziti

Ništa izvan `server/log` osim `node:util`. Područje `log` smije uvoziti samo `settings` ([karta servera, §2](../../../docs/server-map.md#2-dopušteni-uvozi)), pa su vrste računa i radnje iz `server/roles` ovdje prepisane; `server/roles/index.test.ts` provjerava da su jednake tablici prava i da `ADMIN_LOG_ACTIONS` sadrži točno radnje u kojima vrste 3–5 imaju opseg različit od `none`.
