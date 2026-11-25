# server/external/isvu

Područje iz [karte servera](../../../docs/server-map.md).

## Što radi

Port izvora ISVU (`IsvuPort`) i jedini adapter, sintetički (`createSyntheticIsvu`): izmišljeni kolegiji i studenti u kodu, bez mreže i bez tajne. Port daje popis kolegija (`listCourses`), upisane studente u obliku koji čitač uvoza popisa već prima (`listEnrolled`: `identifier`, `givenName`, `familyName`) i prima ocjene (`submitGrades`) samo uz potvrdu nastavnika. Stvarno sučelje ISVU-a ne postoji u repou i ne izmišlja se; stvarno povezivanje čeka ugovor sa Srcem i ustanovom, DPIA i pravnu osnovu (OP-V22-2). Ugovor je [`docs/contracts/isvu-v1.md`](../../../docs/contracts/isvu-v1.md).

Postavka ustanove je `config/faculties/<fakultet>/isvu.json` (`{format: "ductura-faculty-isvu-v1", mode: "off" | "mock"}`). `readIsvuSetting` vraća `mock` samo za točno taj oblik s `mode` točno `"mock"`; sve ostalo je `off`. Tip nema vrijednost za stvarno povezivanje. Produkcija je `PRODUCTION_ISVU_SETTING` = `off` i mijenja se samo vlasnikovim PR-om. `isvuPortFor` daje adapter samo za `mock`; inače `null`, što će ruta odgovoriti s 404.

Ocjene idu van samo kroz `GradeConfirmation`: tip koji stvara jedino `confirmGradeBatch`, nakon što je nastavnik potvrdio pregled serije. Adapter odbija poziv bez potvrde, s potvrdom za drugi kolegij ili drugu seriju (otisak `gradeBatchSha256`), s neispravnom serijom (ocjena samo cijeli broj 1 do 5, najviše 1000 redaka, student jednom) i sa studentom koji nije upisan. Područje ne računa, ne predlaže i ne pohranjuje ocjene (PG-10).

Testovi: `isvu.test.ts` (adapter, potvrda, postavka, datoteke), `no-network.test.ts` (nema mreže, adrese ISVU-a ni Studomata, polja lozinke ni paketa).

## Tko ga zove

Za sada samo testovi. Rute u `server/http` dolaze u zadacima SRV-V22-ISVU-POPIS i SRV-V22-OCJENE-RUTA; tada `http` ulazi u popis pozivatelja i dopuštenih uvoza.

## Koje podatke dira

Ništa trajno. Retci izvora i ocjene postoje samo tijekom poziva; sintetički adapter ih za testove drži u memoriji (`submissions`).

## Što izvozi

- `IsvuPort`, `IsvuCourse`, `IsvuRosterRow`, `IsvuGradeRow`, `IsvuSubmitOutcome`, `GradeConfirmation`;
- `createSyntheticIsvu`, `SYNTHETIC_INSTITUTION_KEY`;
- `readIsvuSetting`, `readIsvuSettingFile`, `isvuPortFor`, `PRODUCTION_ISVU_SETTING`, `ISVU_SETTING_OFF`, `ISVU_SETTING_FORMAT`;
- `confirmGradeBatch`, `gradeBatchSha256`, `isGradeConfirmation`, `isValidBatch`, `isGrade`, `GRADE_MIN`, `GRADE_MAX`, `GRADE_BATCH_MAX_ROWS`.

## Što ne smije uvoziti

Ništa iz drugih područja: ni `domain`, ni druge adaptere iz `external/`. Ne čita okolinu i ne otvara mrežu. Popis je u [karti servera, §2](../../../docs/server-map.md#2-dopušteni-uvozi).
