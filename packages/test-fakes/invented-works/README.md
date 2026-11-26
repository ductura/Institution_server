# @ductura/test-fakes/invented-works

Deterministički generator izmišljenih seminarskih radova i simuliranog pisanja (DAN-1566). Ulaz za kasnije zadatke koji trebaju uvjerljiv, ali potpuno izmišljen rad s poviješću pisanja (DAN-895, DAN-551, DAN-271).

```ts
import { generateInventedWork, serializeInventedWork } from "@ductura/test-fakes/invented-works";

const work = generateInventedWork({ seed: "moje-sjeme", chapters: 3, sessions: 4 });
```

## Što daje

- Rad na hrvatskom: naslov (razina 1), uvod, `chapters` poglavlja (0 do 6), zaključak i popis literature; u tekstu su navodi oblika `(Prezime, 2019)` na izmišljene izvore.
- `author`: izmišljeno ime i adresa na `student.invalid`; svi `https://` izvori su na `primjer.invalid` (`.invalid` se nikad ne razrješava, RFC 6761).
- `segments`: lanac nepotpisanih odsječaka `ductus-evidence-segment-v2` od revizije nula (`initialDocument`) do gotovog rada (`finalDocument`), s koracima `ductus-edit-steps-v1`. Svaki odsječak veže hash prethodnoga (`segmentHashes`).
- Simulirano pisanje, u `sessions` sesija (1 do 8): tipkanje u skupinama od jedne do tri riječi, tipfeleri koji se brišu (`removedSha256`), lijepljenje rečenice (`paste`), izrezivanje i vraćanje (`cut`, `paste`), stanke (razmak između odsječaka; odsječak se prekida na stanci od dvije minute ili više) i povratak na ranije odlomke na početku svake nove sesije.

## Pravila

- Ne objavljuje se u tarballu (kao `dev-server` i `pglite`): generator uvozi `server/domain` i serverski replayer, pa ga potrošači unutar ovog repoa koriste kroz `@ductura/test-fakes/invented-works`, a `release.ts` i `scripts/release` ga namjerno ne sadrže.
- Isto sjeme i iste mogućnosti daju bajt-identičan `serializeInventedWork` na svakom računalu: samo cjelobrojna aritmetika (`random.ts`), nikad `Math.random`, sat ni okolina. Vremena su pomak od fiksnog izmišljenog datuma.
- Generator ništa ne potpisuje i ne čita nikakav ključ. Potpis (potvrdu) dodaje pozivatelj ključem iz fixturea.
- Sav tekst, imena i adrese su izmišljeni (`corpus.ts`); test provjerava rječnik zabranjenih izraza (`scripts/forbidden-terms`) i nečitljive znakove nad cijelim izlazom.
- Što dokazuje `invented-works.test.ts`: svaki odsječak prolazi `isEvidenceSegmentV2`, lanac `verifyEvidenceChainV2`, a koraci se ponavljaju serverskim replayerom (`createEditStepsV1Replayer`) od revizije nula do `finalDocument`; promijenjen `removedSha256` ruši ponavljanje.
- Promjena generatora mijenja bajtove: test „pins the bytes” traži novu vrijednost u istom PR-u.
- Ne diraj `corpus.ts` sadržajem koji bi mogao nalikovati stvarnom studentskom radu ili osobi.
