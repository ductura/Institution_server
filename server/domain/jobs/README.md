# server/domain/jobs

Tijelo posla u redu poslova, iz Ductusa `src/application/jobs/job-body.ts` na `333e163` (DAN-820, VS-1b dio 1; plan napada ductura/server#146), bez promjene logike, s testom.

- `parseJobBody(input, fields)`: prihvaća samo običan zapis čiji su vlastiti ključevi točno `fields`, a vrijednosti UUID-ovi u jedinom zapisu koji baza ispisuje (mala slova, s crticama). Vraća novi zamrznuti zapis ili zatvoreni kod problema (`JobBodyProblem`), nikad vrijednost odbijenog ulaza. Svaka vrijednost čita se jednom, iz opisnika svojstva, pa se getter ne izvodi.
- `isJobDefinition(definition)`: ime reda, popis različitih polja i polje predmeta među njima.

Isti čuvar radi prije upisa u red i ponovno prije izvođenja (`server/database/job-queue.ts`), pa tekst rada ni ključ ne stižu u red ni jednim putem (D-74). Kodovi problema su unutarnji kodovi workera i ne prikazuju se korisniku.

Ne uvozi ništa.
