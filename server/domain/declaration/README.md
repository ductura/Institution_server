# server/domain/declaration

Izjava o radu v1 po ugovoru `ductura-declaration-v1` (ductura/Institution_server#499, odjeljci 1 do 4, 7.1 i 9), prvi korak domene (SRV-1210). Samo čiste funkcije bez I/O; rute, RPC i tablice dolaze u sljedećim koracima.

- **Payload** (`payload.ts`): `isDeclarationPayloadV1` zatvoreno provjerava svaki ključ na svakoj razini (§1), `parseDeclarationPayloadV1Bytes` prihvaća samo kanonske JCS bajtove (bez dvostrukog ključa i bez završnog novog reda), a `declarationSha256` je SHA-256 JCS-a payloada (§1.7). Vektor iz §9 je u testu bajt po bajt.
- **Tekst** (`text.ts`): tekst izjave je NFC, neprazan, bez rubnih razmaka, BOM-a, osamljenog surogata, C0/C1 kontrolnih i bidi znakova; novi red samo u višerednom polju. Duljina se broji u kodnim točkama. Tekst koji nije NFC se odbija, ne normalizira.
- **Privici** (`attachments.ts`): razgovor (`messagesSha256` je SHA-256 JCS niza hashova poruka, redom) i vanjski privitak. `checkExternalAttachmentBytes` prima samo `text/plain` (UTF-8 bez BOM-a, bez CR i NUL) i `application/pdf` (zaglavlje `%PDF-`); nepoznat format daje `unsupported_media_type`, loši bajtovi `invalid_input`. `sortAttachments` slaže po redu razloga pa po id-u.
- **Razlozi** (`reasons.ts`): `resolveAttachmentReason` prolazi tablicu §2.2 redom i vraća prvi razlog koji vrijedi; `transferred`, `transferred_deleted` i `pasted_known` su obvezni.
- **Granice** (`constants.ts`): sve iz §4. `MAX_ATTACHED_CONVERSATIONS` broji samo razgovore koje je student dodao; obvezni razgovori nemaju gornju granicu.
- **Tijelo spremanja** (`put-body.ts`): `parseDeclarationPutBody` je zatvoren; svaki nepoznat ključ, uključujući `reason`, `recorded`, `principalId` i `confirmedAt`, daje `invalid_input`. `incompleteFields` kaže što još priječi `confirm: true` (409 `incomplete`).
- **Obrazac** (`form.ts`): datoteka obrasca je JCS zatvorenog objekta (`formSchema`, `formId`, `formVersion`, `text`), po želji s jednim završnim novim redom. `formSha256` je SHA-256 JCS-a bez tog reda. Službenog obrasca fakulteta u repou nema (OD-11); `testdata/test-izjava.v1.json` je izmišljen obrazac za testove.

Testovi: `declaration.test.ts` (vektor, granice, tekst, formati, tablica razloga, tijelo, obrazac) i `put-body.property.test.ts` (fast-check: svaki višak ili manjak ključa daje `invalid_input`).

Uvozi samo [`../forensics`](../forensics/README.md) (`canonicalizeJcs`) i `node:crypto`.
