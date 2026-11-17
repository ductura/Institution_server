# server/domain/support

Prijava problema („Prijavi problem”), iz Ductusa `src/domain/support/problem-report.ts` na `220b5db` (DAN-431; prijenos DAN-851-2a2), bez promjene logike, s testovima. Izmjene: popisi su zamrznuti (`Object.freeze`), `interface` je `type` ([docs/CODE_STYLE.md](../../../docs/CODE_STYLE.md) §4), a uvozi su relativni s `.ts` (stanja sinkronizacije iz [`../sync`](../sync/README.md)).

- `parseProblemReport(value)`: vraća prijavu samo za običan objekt s točno šest ključeva (`appVersion`, `browser`, `category`, `description`, `route`, `syncState`), a `browser` s točno `family` i `major`. Svaka vrijednost mora biti iz zatvorene klase; sve ostalo je `null`. Nijedno polje ne može nositi tekst rada, odlomak, naslov ni zapis dnevnika (D-69, Ductus `docs/PRODUCT.md` §5).
- `isProblemDescription`: 1 do 1000 kodnih točaka, barem jedan vidljiv znak, bez osamljenog surogata, kontrolnog znaka (osim LF i taba) i bidi znaka.
- `isAppVersion`: izdanje (`1.2.3`, po želji `+commit`) ili golo ime commita, samo znamenke i mala hex slova.
- `problemReportRoute(pathname)`: predložak rute stranice umjesto putanje (bez upita i hasha, id segment postaje ime u zagradama), ili `null`.
- Konstante: `PROBLEM_REPORT_DESCRIPTION_MAX` (1000), `PROBLEM_REPORT_HOURLY_LIMIT` (5, broji baza pod zaključavanjem), `PROBLEM_REPORT_CATEGORIES`, `BROWSER_FAMILIES`, `PROBLEM_REPORT_ROUTES` (27 predložaka) i `PROBLEM_REPORT_KEYS`.

Ista ograničenja su CHECK-ovi tablice `identity.problem_report` (migracija `20261112110000` i četiri migracije popisa ruta); baza ostaje autoritet. Identitet i ustanova dolaze iz sesije, nikad iz tijela.

Poznata granica: provjera ključeva koristi `Object.keys`, pa simbolni i neprebrojivi ključevi te getteri nisu zatvoreni. `JSON.parse` takve ne proizvodi, a servis predaje samo njegov izlaz. Za razliku od `parseInterfaceLocaleSetting` ([`profile`](../profile/README.md)), objekt bez prototipa se odbija.

Slaganje s migracijom, s ugovorom `support.problem-report.post` i s njegovim vektorima te property testovi dolaze s DAN-851-2a3.

Uvozi samo [`../sync`](../sync/README.md).
