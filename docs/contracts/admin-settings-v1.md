# Postavke fakulteta za administratora v1: asistent, izvoz podataka i rokovi čuvanja

**Status: aditivno proširenje postojećih ruta i jedna nova ruta samo za čitanje.** SRV-ADMIN-3 `admin-postavke-izvoz`, `Risk: critical` (Ductus#2055, nalog c.7116134498). Izvor: odluke vlasnika 23. 11. 2026. za NF-7 (točke 2, 5, 6 i preporuke OA-2, OA-6, OA-9, OA-12) i nalaz `docs/nalazi/nove-funkcije-7-operater-administracija.md` u WEB repou.

Ništa postojeće se ne lomi: `pnpm contracts:breaking origin/migracija/kopija-ductus-backend` ne nalazi promjenu koja lomi klijente. Verzija API-ja raste s 1.97.0 na 1.98.0 (nova ruta i nova neobavezna polja odgovora).

## 1. Postavka asistenta na razini fakulteta (OA-9, odluka 6, OC-1)

`GET /api/v1/institution/assistant-setting` (`institution.assistant-setting.get`), samo potvrđeni administrator ustanove; ostali 403, bez sesije 401, bilo koji upit 422.

| Polje            | Značenje                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `assistant`      | Asistent odgovara na ovom poslužitelju (učitana je konfiguracija pružatelja). Pružatelj i model se nikad ne imenuju (Q-10).          |
| `transcription`  | Prekidač fakulteta (OC-1): transkripcija dopuštena.                                                                                  |
| `tools`          | Prekidač fakulteta (OC-1): alati dopušteni.                                                                                          |
| `settingVersion` | Verzija postavke fakulteta `config/faculties/<fakultet>.json`; `null` kad fakultet nema postavku (tada su oba prekidača isključena). |
| `changeable`     | Uvijek `false`: prekidač se mijenja samo vlasnikovim PR-om, nikad s ekrana.                                                          |

- Ustanova dolazi samo iz sesije; tko je administrator odlučuje baza (`institution.actor_has_role('admin')`).
- Postavka se čita jednom, pri sastavljanju poslužitelja. Nijedna ruta je ne mijenja.
- U produkcijskom sastavu nema konfiguracije pružatelja, pa je `assistant` `false` dok vlasnik ne odluči drukčije (Q-10); lažni dev server vraća izmišljeno `true`.
- Što pravila fakulteta dopuštaju po vrsti rada već daje `institution.faculty-rules.get`; ova ruta to ne ponavlja.

## 2. Obrasci fakulteta za čitanje (OA-2)

Katalog obrazaca fakulteta (`institution.thesis_form`, `app.read_thesis_forms`) uvodi SRV-MENTOR-2 (PR #668). Po nalogu se ne duplicira: ruta za čitanje obrazaca na razini fakulteta ide s tim zadatkom. Obrazac izjave ostaje verzionirana datoteka u `config/faculties/<fakultet>/declaration/` (OD-11).

## 3. Zahtjevi za izvoz podataka studenta (OA-6)

- Popis (`institution.student-data-exports.get`) već izlaže sva stanja: `requested` (čeka odobrenje), `approved` (odobren), `ready` (pripremljen, poveznica vrijedi 24 sata), `downloaded` (preuzet) i `expired` (istekao).
- Drugi otvoren zahtjev za istu osobu baza već odbija (jedinstveni indeks `student_data_export_open_idx` nad stanjima `requested`, `approved` i `ready`; pgTAP 184). Novo je da 409 zahtjeva (`institution.student-data-exports.post`) uvijek nosi razlog i ključ teksta iz kataloga:

```json
{
  "error": "conflict",
  "code": "conflict",
  "messageKey": "errors.conflict",
  "status": 409,
  "reason": "export_already_open",
  "reasonKey": "adminSettings.exportAlreadyOpen"
}
```

- Tekst `adminSettings.exportAlreadyOpen` je u `locales/hr.ts` i `locales/en.ts`. Polja su u v1 neobavezna (novo polje odgovora); poslužitelj ih šalje na svaki 409 zahtjeva. 409 odobrenja (zahtjev više ne čeka) ostaje bez razloga.

## 4. Rokovi čuvanja (odluka 5)

`institution.retention.get` uz svaku klasu sad vraća i `periodStatus` i `periodStatusKey` (neobavezna polja):

| `periodStatus`      | Kada                                                                         | `retentionDays` | Tekst (`periodStatusKey`)                        |
| ------------------- | ---------------------------------------------------------------------------- | --------------- | ------------------------------------------------ |
| `decided`           | rok je određen                                                               | broj dana       | `adminSettings.retentionPeriod.decided`          |
| `awaiting_decision` | rok nije određen; određuje ga fakultet                                       | `null`          | `adminSettings.retentionPeriod.awaitingDecision` |
| `never_deleted`     | klasa dokazuje predaju i nakon brisanja sadržaja i nikad se ne briše (D-272) | `null`          | `adminSettings.retentionPeriod.neverDeleted`     |

Nijedan rok nije izmišljen. Klasa s `null` rokom ostaje probni prolaz i ništa se ne briše.

### Klase bez roka: rok određuje fakultet prije pilota

Po odluci 5 rokovi moraju biti određeni prije pilota, a određuje ih fakultet. Danas bez roka (`awaiting_decision`, katalog `server/domain/retention/catalog.ts`, test `server/database/retention-dry-run/index.test.ts`):

| Ključ          | Klasa (Ductus `docs/privacy/06-klase-podataka.md` §2) | Napomena                           |
| -------------- | ----------------------------------------------------- | ---------------------------------- |
| `live-state`   | 15: stanje uređivanja uživo                           | danas se samo broji                |
| `versions`     | 13, 14: verzije rada                                  | danas se samo broji                |
| `change-times` | 22: vrijeme pojedinih izmjena                         | nema vlastite pohrane, ne broji se |
| `access-log`   | 25: zapis pristupa                                    | danas se samo broji                |

Određene ili izvan odluke: `sessions` (30 dana nakon kraja, D-273, briše se) i `receipts` (27: sažeci i potvrde predaje, ne brišu se nikad, D-272).

Pitanje za odluku: rok za svaku od četiri klase (rokove određuje fakultet). Druge klase koje se ne vode u ovom katalogu (npr. sadržaj tipki iz Ustava v1.9, najkasnije 30 dana nakon predaje) nisu dio ove rute.

## 5. Testovi

- `server/institution/assistant-setting.test.ts`, `server/http/assistant-setting/index.integration.test.ts` (vektori, 401, 403, 422, 503, bez pružatelja i modela);
- `server/external/assistant-tools/faculty-config.test.ts` (`settingOf`);
- `server/http/student-data-export/index.integration.test.ts` („the reason of a 409”);
- `server/database/retention-dry-run/index.test.ts` (stanje roka i popis klasa bez roka);
- vektori `server/contracts/vectors/institution.assistant-setting.get.json`, dopunjeni `institution.retention.get.json` i `institution.student-data-exports.post.json`; lažni dev server `packages/test-fakes/dev-server/assistant-setting-routes.ts`.
