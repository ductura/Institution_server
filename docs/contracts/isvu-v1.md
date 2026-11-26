# Ugovor izvora ISVU, verzija 1 (probni izvor)

Status: nacrt za val 22 (SRV-V22-ISVU-PORT). Izvor odluka: Ductus, WEB `docs/nalazi/val22-razlika.md`, §3.

**Ovo nije format Srca ni ISVU-a.** Oblik ispod je izmišljen, služi samo probnom (sintetičkom) adapteru i ne smije se čitati kao opis stvarnog sučelja. Format stvarnog izvoza nije poznat; nikakav poziv prema Srcu, struganje stranica ni tuđe lozinke ne postoje. Prijava ostaje isključivo AAI@EduHr.

## 1. Postavka ustanove

`config/faculties/<fakultet>/isvu.json`:

```json
{ "format": "ductura-faculty-isvu-v1", "mode": "off" }
```

- `mode` je `"off"` ili `"mock"`. Vrijednost koja nije točno `"mock"` znači `off`; isto vrijedi za nedostajuću ili neispravnu datoteku, drugi `format`, dodatni ključ ili datoteku veću od 4 KiB.
- Tip nema vrijednosti za stvarno povezivanje, pa se ono ne može uključiti slučajno.
- Produkcija je konstanta `PRODUCTION_ISVU_SETTING` = `off`; mijenja se samo vlasnikovim PR-om. Danas je `mock` samo u `demo-fakultet`; `fpzg` je `off`.
- Kad je postavka `off`, rute koje će koristiti port odgovaraju postojećim `404 not_found` (ne otkrivaju da integracija postoji), bez novog koda greške.

## 2. Port

| Operacija                                            | Ulaz                             | Izlaz                                                               |
| ---------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `listCourses`                                        | `{institutionKey, academicYear}` | popis `{sourceCourseKey, name, academicYear, enrolledCount}`        |
| `listEnrolled`                                       | `sourceCourseKey`                | retci `{identifier, givenName, familyName}` ili `null` bez kolegija |
| `submitGrades(sourceCourseKey, batch, confirmation)` | serija `{identifier, grade}`     | `{ok: true, sent, mode: "mock"}` ili `{ok: false, reason}`          |

Retci popisa imaju oblik koji čitač uvoza popisa (`server/institution/roster-import.ts`) već prima; identifikator je AAI@EduHr (`korisnik@domena`, mala slova). Studenti se podudaraju s računom samo točnim identifikatorom, nikad imenom.

## 3. Ocjene

- Ductura ne računa, ne predlaže i ne pohranjuje ocjenu (PG-10). Ocjenu upisuje nastavnik, cijeli broj 1 do 5; serija ima 1 do 1000 redaka, student je u njoj najviše jednom.
- Adapter prima seriju samo uz `GradeConfirmation`. Tip stvara isključivo `confirmGradeBatch`, nakon što je nastavnik potvrdio pregled; literal objekta se odbija.
- Otisak serije je SHA-256 (hex) redaka poredanih po identifikatoru, `identifikator TAB ocjena LF` po retku. Redoslijed unosa ne utječe na otisak.
- Razlozi odbijanja: `no_confirmation` (nema potvrde ili je za drugi kolegij), `batch_mismatch` (serija ne odgovara potvrđenom otisku), `invalid_batch`, `unknown_course`, `not_enrolled`. U odbijenom pozivu ništa se ne prosljeđuje.
- Popis ocjena nema zbirki: nema prosjeka, raspodjele ni sortiranja po ocjeni.

## 4. Granice

- Samo sintetički adapter: izmišljeni kolegiji i studenti (iste osobe kao u `db/main/local/lazni-oidc-racuni.json`, uz dvije izmišljene osobe bez računa), bez mreže i bez tajne. Test `server/external/isvu/no-network.test.ts` čuva da u repou nema adrese ISVU-a ni Studomata, mrežnog poziva ni paketa.
- Rute popisa (SRV-V22-ISVU-POPIS): `institution.isvu-courses.get` (`GET /api/v1/institution/admin/isvu/courses?academicYear=`) i `institution.isvu-roster-imports.post` (`POST /api/v1/institution/admin/courses/{courseId}/isvu-roster-imports`, tijelo `{sourceCourseKey}`), samo administrator ustanove. Odgovor pregleda je isti kao kod `institution.roster-imports.post` (izvor `isvu`); potvrda je postojeća `institution.roster-import-confirm.post`. Postavka `off` (zadano; u produkciji uvijek, jer se datoteka postavke čita samo lokalno i u CI-ju) i nepoznat `sourceCourseKey` daju postojeći `404 not_found`; ne-administrator dobiva 403 prije provjere postavke. Izvor se preslikava na račune samo po identifikatoru AAI@EduHr. Izvoz ocjena je SRV-V22-OCJENE-RUTA.
- Otvoreno: stvarno povezivanje (OP-V22-2), dnevnik radnji administratora (OP-V22-3), trajno preslikavanje kolegija (OP-V22-4).
