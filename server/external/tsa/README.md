# server/external/tsa

Područje iz [karte servera](../../../docs/server-map.md).

## Što radi

Port žiga vremena RFC 3161 za dnevnu kontrolnu točku (ISTR-2 koraci 1 i 2, redak plana M3.9a; D-72, D-209). Plan je `docs/plan/ISTR-2-TSA.md` u `ductura/.github`; odluke O-1 do O-6 donesene su 27. 11. 2026.

- `buildTimeStampRequest` gradi `TimeStampReq` v1: otisak SHA-256 od točno 32 bajta, nov jednokratni broj (`newNonce`, 16 bajtova, 126 slučajnih bitova) za svaki pokušaj i `certReq = true`. TSA-u ide samo otisak; sadržaj, identifikator ni ime nikad ne dolaze do ovog modula.
- `verifyTimeStampResponse` provjerava `TimeStampResp` ovim redom: DER bez viška bajtova, status (`granted` ili `grantedWithMods`), `SignedData` s jednim potpisnikom nad `TSTInfo` v1, algoritam i vrijednost otiska, jednokratni broj, `genTime` unutar prozora oko zahtjeva, certifikat potpisnika u odgovoru, ESSCertIDv2 (RFC 5035), valjanost certifikata u `genTime`, EKU (jedno kritično proširenje, samo `timeStamping`), potpis CMS-a (content-type, message-digest, potpis nad potpisanim atributima) i lanac do fiksiranog sidra u trenutku `genTime`. Lanac se gradi samo iz odgovora, `extraCertificates` i sidara, bez mreže. Dijelovi izvan potpisa moraju se slagati s potpisanima: `digestAlgorithms` sadrži algoritam potpisnika, a svaki certifikat na putu ima isti vanjski i unutarnji algoritam, BIT STRING potpisa bez neiskorištenih bitova i ECDSA potpis u strogom DER-u.
- Svaki očekivani neuspjeh je rezultat s kodom (`TSA_ERROR_CODES`) i ključem `tsa.*` u `locales/hr.json`; funkcija ne baca ni za jedan ulaz (property test).
- `requestTimeStamp` šalje jedan pokušaj (`POST application/timestamp-query`, bez preusmjeravanja, istek po TSA-u, odgovor najviše 256 KiB). `stampWithTsa` radi do `maxAttempts` pokušaja s udvostručenim čekanjem, svaki s novim jednokratnim brojem (O-4 (a)). `stampWithAll` zove svaki TSA iz konfiguracije neovisno i istodobno, bez rezervnog (O-2 (c)); `anyVerified` kaže je li dan uspio (ADR §5 t. 5).
- Popis TSA-ova je konfiguracija (`parseTsaConfig`, format `ductura-tsa-v1`). `PILOT_TSA_CONFIG` su DigiCert i Sectigo; FINA kasnije ulazi kao treći unos bez promjene koda (O-1 (b)).
- `fetch` uvijek ubacuje pozivatelj: modul nikad ne dohvaća globalni `fetch` i ne uvozi mrežne module (`no-network.test.ts`). Testovi i CI zovu samo lažni TSA iz `@ductura/test-fakes/tsa`.

Tvrdnja ostaje ograničena (`BACKEND.md` §4.2, ADR §10 t. 1): žig pokazuje da su ti bajtovi postojali najkasnije u `genTime`, ništa o sadržaju, autorstvu ni potpunosti dnevnika.

Nije ovdje: dnevni posao radnika i pohrana `.tsr`, CRL-a ili OCSP odgovora (korak 3, čeka M3.2 i M3.9-P05, O-6 (a)), provjera spremljenog žiga u `evidence:verify` (korak 4) i stvarni korijenski certifikati DigiCerta i Sectiga (O-3 (a), uz korak 3).

Testovi: `golden.integration.test.ts` (svaki način lažnog TSA-a daje točan kod), `client.integration.test.ts` (prijenos, pokušaji, dva TSA-a), `verify.property.test.ts` (promjena jednog bajta otiska, jednokratnog broja ili odgovora), `request.test.ts`, `config.test.ts`, `errors.test.ts`, `no-network.test.ts`.

## Tko ga zove

Još nitko u produkcijskom kodu. Prvi pozivatelj je radnik dnevne kontrolne točke (ISTR-2 korak 3); on jedini zove stvarne TSA-ove, u okolini s mrežom.

## Koje podatke dira

Ništa trajno. Otisak, jednokratni broj i odgovor postoje samo tijekom poziva; bajtove odgovora vraća pozivatelju točno kako su primljeni.

## Što izvozi

- `buildTimeStampRequest`, `newNonce`, `DIGEST_BYTES`, `NONCE_BYTES`, `RandomSource`;
- `verifyTimeStampResponse`, `parseAnchorsPem`, `parseCertificates`, `TimeStampExpectation`, `TrustMaterial`, `VerifiedTimeStamp`;
- `requestTimeStamp`, `stampWithTsa`, `stampWithAll`, `anyVerified`, `TsaClientDeps`, `TsaFetch`, `TsaStampOutcome`, `TIME_STAMP_QUERY`, `TIME_STAMP_REPLY`, `MAX_RESPONSE_BYTES`;
- `parseTsaConfig`, `PILOT_TSA_CONFIG`, `TsaConfig`, `TsaEndpoint`, `TSA_CONFIG_FORMAT` i granice `TSA_MAX_*`;
- `TSA_ERROR_CODES`, `tsaError`, `tsaMessageKey`, `TsaError`, `TsaErrorCode`, `TsaResult`.

## Što ne smije uvoziti

Ništa iz drugih područja: ni `domain`, ni druge adaptere iz `external/`. Jedine vanjske ovisnosti su `pkijs` i `asn1js` na točnim verzijama. Popis je u [karti servera, §2](../../../docs/server-map.md#2-dopušteni-uvozi).
