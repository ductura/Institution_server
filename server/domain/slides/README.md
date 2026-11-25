# server/domain/slides

Kanonski dokument rada vrste `slides` (val 13, SRV-V13-UGOVOR-SLAJD; ugovor [docs/contracts/slides-v1.md](../../../docs/contracts/slides-v1.md)). Zasebna linija s vlastitim `schemaVersion` od 1; ne proširuje tekstne sheme 1 do 4, pa tekstni radovi ostaju bajt-jednaki. Samo čiste funkcije bez I/O-a.

- **Tipovi i granice** (`schema.ts`): zatvoreni popisi rasporeda, mjesta (slotova) i vrsta blokova, kapaciteti i ograničenja.
- **Validator** (`validate.ts`): `validateSlidesDocument` odbija, nikad ne popravlja; zatvoren skup ključeva, samo cijeli brojevi, tekst po pravilima dokumenta v2, blokovi u redoslijedu mjesta rasporeda, jedinstveni ID-evi, slika s `attachmentId` i SHA-256.
- **Snimka** (`snapshot.ts`): JCS (RFC 8785) i SHA-256; `verifySlidesSnapshot` prima samo točne JCS bajtove valjanog dokumenta, najviše 2 MiB; `slidesDocumentsEqual`.
- **Revizija nula** (`revision-zero.ts`): jedan prazan slajd `titleContent` s fiksnim ID-em, poznati bajtovi i hash.
- **Zlatni vektori** (`golden-vectors-v1.json`): izračunati izvan koda (Python), uspoređuju se kako su zapisani.

Koraci uređivanja slajdova (`ductus-slide-steps-v1`) dolaze u SRV-V13-KORACI-SLAJD. Uvozi samo [`../json`](../json/README.md), [`../document`](../document/README.md) (popis zabranjenih znakova) i [`../forensics`](../forensics/README.md) (JCS) te `node:crypto`.
