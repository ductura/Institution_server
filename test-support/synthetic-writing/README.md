# test-support/synthetic-writing

Generator izmišljenih seminarskih radova i simuliranog pisanja (DAN-1566), da testovi i demo nikad ne trebaju stvarni studentski rad ni stvarnu osobu.

```ts
import { generateSyntheticWriting } from "../../test-support/synthetic-writing/index.ts";

const writing = await generateSyntheticWriting({ seed: 7, sections: 3 });
```

Isto sjeme daje isti izlaz, bajt po bajt. Nigdje se ne koristi `Math.random` ni trenutačno vrijeme.

## Što daje

- `paper`: izmišljeni autor (ime počinje s „Izmišljena” ili „Izmišljeni”, adresa na `student.example.invalid`), naslov, poglavlja s odlomcima i jedna rečenica koja se zalijepi.
- `initialDocument`, `finalDocument`, `finalDocumentHash`: revizija nula i dokument na kraju pisanja.
- `segments`, `segmentTexts`, `segmentHashes`: odsječci evidencije v2 u formatu `ductus-edit-steps-v1`, njihov kanonski JCS tekst i sažeci, povezani u lanac.
- `stats`: broj događaja, upisanih, obrisanih i zalijepljenih znakova te broj sesija.

## Kako pisac piše

Naslov, pa svako poglavlje: naslov poglavlja i odlomci, upisani u kratkim naletima od jednog do pet znakova. Povremeno upiše krivi znak i obriše ga. Jednom po poglavlju vrati se, obriše zadnju riječ jednog odlomka i upiše je ponovno. Prvo poglavlje završava jednim zalijepljenim odlomkom (izvor `paste`). Svako sljedeće poglavlje je nova sesija nakon stanke od više sati. Odsječak se zatvara nakon `segmentEvents` događaja ili na kraju sesije.

## Provjera

Testovi provjeravaju izlaz istim domenskim kodom koji poslužitelj koristi za stvarni zapis (`isEvidenceSegmentV2`, `parseEditSteps`, `verifyEvidenceChainV2`) i rječnikom zabranjenih izraza.

Da koraci stvarno vode do zapisanih sažetaka dokumenta provjereno je jednom, ručno, izvođačem koraka iz Ductusa (`createEditStepsV1Replayer` uz `replayEvidenceSegmentsV2`) za sedam sjemena i jedno do pet poglavlja. Ta provjera nije u testovima ovog repoa jer ovdje nema izvođača koraka.

## Poznate granice

- **Nije izvođač koraka.** Pisac vodi vlastiti popis blokova i piše samo četiri oblika koraka: upis teksta, brisanje unutar jednog bloka, dijeljenje bloka i promjenu vrste bloka. Ne zna čitati korake koje nije sam napisao.
- **Bez oznaka i bez spajanja blokova.** Nema podebljanja, kurziva, citata ni brisanja preko granice bloka.
- **Bez potvrda.** Ništa se ne potpisuje. Test koji treba potvrde potpisuje ih ključem koji sam napravi; ključ ustanove se ovdje nikad ne koristi.
- **Vrijeme je izmišljeno.** Stanke nisu model stvarnog pisanja i ne smiju se koristiti za ocjenu ikakve mjere ponašanja.
- **Samo za testove i demo.** Produkcijski kod ovo ne uvozi. Mapa nije dio paketa `@ductura/test-fakes`, pa je repo sučelja zasad ne može uvesti.
