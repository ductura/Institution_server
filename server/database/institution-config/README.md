# server/database/institution-config

## Što radi

Konfiguracija ustanove i pravila fakulteta (SRV-1405, M2.12 i M2.17; D-117, D-199). Zatvorena shema (zod, `ductura-faculty-rules-v1`) provjerava datoteku `config/faculties/<fakultet>/rules.json` pri pokretanju i svaku verziju koju administrator objavi u `app.institution_config`. Verzija se samo dodaje; zadatak pamti verziju koja je vrijedila kad je izrađen i nastavlja je čitati i nakon nove.

Shema drži samo odlučene postavke ustanove koje nisu drugdje: stil citiranja (D-83) i jezike rada (F-06). Pravilo AI-ja po vrsti rada je u `institution.faculty_rule_version` (DAN-315), a prekidač AI-ja ustanove u `config/faculties/<fakultet>.json` (OC-1, samo vlasnikovim PR-om). Pragovi, rokovi čuvanja i pružatelji nisu odlučeni i nemaju polje.

## Tko ga zove

`server.ts` pri pokretanju (`facultyRulesProblems`, kroz `server/http`): neispravna datoteka zaustavlja pokretanje s kodom `FACULTY_RULES_*` i izlazom EX_CONFIG. Port `createInstitutionConfigStore` koristit će ruta administratora i čitanje pravila zadatka.

## Koje podatke dira

Čita `config/faculties/<fakultet>/rules.json`. U bazi poziva `app.publish_institution_config` i `app.assignment_institution_config` te čita `app.institution_config` kroz RLS. Aktera uzima iz sesije.

## Što izvozi

Shemu i njezine konstante, učitavač (`loadFacultyRules`, `facultyRulesProblems`, kodove grešaka) i port `createInstitutionConfigStore`.

## Što ne smije uvoziti

Nema HTTP ovisnosti. Pristup bazi samo kroz `WithActor`.
