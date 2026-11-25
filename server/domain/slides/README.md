# server/domain/slides

Kanonski dokument rada vrste `slides` (val 13, SRV-V13-UGOVOR-SLAJD; ugovor [docs/contracts/slides-v1.md](../../../docs/contracts/slides-v1.md)). Zasebna linija s vlastitim `schemaVersion` od 1; ne proširuje tekstne sheme 1 do 4, pa tekstni radovi ostaju bajt-jednaki. Samo čiste funkcije bez I/O-a.

- **Tipovi i granice** (`schema.ts`): zatvoreni popisi rasporeda, mjesta (slotova) i vrsta blokova, kapaciteti i ograničenja.
- **Validator** (`validate.ts`): `validateSlidesDocument` odbija, nikad ne popravlja; zatvoren skup ključeva, samo cijeli brojevi, tekst po pravilima dokumenta v2, blokovi u redoslijedu mjesta rasporeda, jedinstveni ID-evi, slika s `attachmentId` i SHA-256.
- **Snimka** (`snapshot.ts`): JCS (RFC 8785) i SHA-256; `verifySlidesSnapshot` prima samo točne JCS bajtove valjanog dokumenta, najviše 2 MiB; `slidesDocumentsEqual`.
- **Revizija nula** (`revision-zero.ts`): jedan prazan slajd `titleContent` s fiksnim ID-em, poznati bajtovi i hash.
- **Zlatni vektori** (`golden-vectors-v1.json`): izračunati izvan koda (Python), uspoređuju se kako su zapisani.

- **Koraci** (`steps.ts`, SRV-V13-KORACI-SLAJD): format `ductus-slide-steps-v1` (`SLIDE_STEP_FORMAT_V1`), devet koraka: `slideAdd`, `slideRemove`, `slideMove`, `layoutSet`, `blockSet`, `blockRemove`, `textEdit`, `notesSet`, `notesRemove`. `parseSlideStep` i `parseSlideSteps` imaju zatvoren skup ključeva, nepoznat korak je `unknown_step` (nikad se ne preskače), pozicije su nenegativni sigurni cijeli brojevi, blok u koraku provjerava sam validator dokumenta; korak koji uklanja sadržaj nosi SHA-256 uklonjenog (`removedSha256`), pa se brisanje ne događa nečujno. Najviše 1000 koraka i 2 MiB po događaju.
- **Primjena** (`apply.ts`): `applySlideStep` i `applySlideSteps` su čiste i atomarne; ulaz se ne mijenja, odbijen korak ne ostavlja trag (javlja se šifra i indeks), a rezultat nakon svakog koraka prolazi `validateSlidesDocument`, pa vrijede sve granice ugovora (npr. nikad manje od jednog slajda). `layoutSet` se odbija ako neki blok nema mjesto u novom rasporedu (blokovi se ne brišu ni ne sele sami). Pozicije u `textEdit` broje točke koda. Koraci „postavi” (`blockSet`, `notesSet`, `layoutSet`, `slideMove`) su idempotentni; dodavanje i uklanjanje nisu (drugi put se odbijaju).

Koraci nemaju API, potpis ni lanac: to je SRV-V13-EVIDENCE-SLAJD. Uvozi samo [`../json`](../json/README.md), [`../document`](../document/README.md) (popis zabranjenih znakova) i [`../forensics`](../forensics/README.md) (JCS) te `node:crypto`.
