# server/institution

Područje iz [karte servera](../../docs/server-map.md) (DAN-852-1, S-M-2a). Prenosi Ductus `src/server/institution` za kolegije ustanove: kreiranje kolegija, kôd upisa i njegov opoziv. Nema `routes.ts`: rute su u `server/http`, kao kod `profile`.

## Što radi

Feature područje. Danas ima samo provjeru tijela kolegija `parseCourseBody` (`schemas.ts`), doslovni prijenos Ductus `courseInput` iz `create-course.ts`: objekt s točno vlastitim ključevima `name`, `academicYear` i `aiPolicy`; ime od 1 do 160 UTF-16 jedinica bez razmaka (JS `trim`) na rubovima; godina `YYYY/YYYY` u kojoj je druga za jedan veća od prve; politika `prohibited`, `partially_allowed` ili `encouraged`. Sve drugo daje `null`, što ruta pretvara u 422. Ime dalje sudi RPC (`institution.is_plain_label`). Servis nad portom baze dolazi s DAN-852-3.

## Tko ga zove

Samo `http`.

## Koje podatke dira

Danas nijedne. Servis će čitati i pisati kolegije i kodove upisa u glavnoj bazi samo kroz RPC `institution.create_course()`, `institution.create_enrollment_code()` i `institution.revoke_enrollment_code()`. Pozivatelj, ustanova i članstvo dolaze iz sesije, nikad iz tijela.

## Što izvozi

- `parseCourseBody(value)` i tipove `CourseBody` i `AiPolicy` (`schemas.ts`); funkcija nikad ne baca i vraća novi objekt s točno tri ključa;
- `InstitutionService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain` i `database`, i to kroz njihov `index.ts`. `database` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http`, `contracts`, `session` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjera je lint `local/area-boundary`.
