# Rasponi podrijetla po odlomku v1

Zadatak: SRV-KARTA-RASPON `podrijetlo-rasponi-odlomaka` (Ductus#2055, nalog c.7140935386; NF-5 PG-2, karta podrijetla). Status: **aditivno, unatrag kompatibilno** (API 1.113.0). Ovisi o SRV-0910 (`work.origin-composition.get`, migracija `20261213100300`) i SRV-1230 (`work.assistant-match.*`, migracija `20261213100800`).

## Zašto

`work.origin-composition.get` daje samo udio po vrsti (`parts[{kind, percent}]`), a `evidence.origin_change` nema položaj u tekstu. Karta podrijetla (WEB-NF5-KARTA) zato ne može označiti odlomak, a `segmentRef` iz `work.assistant-match.get` ne vodi ni do kakvog raspona. Ovaj ugovor dodaje raspone jedne revizije rada.

## Načela

- Raspon kaže **odakle je tekst došao, nikad tko ga je tipkao**. Nema automatskog zaključka o autorstvu, ni ocjene, ni rangiranja; prikaz uz kartu ostaje napomena „nije dokaz autorstva” (C-6, P-1).
- Iste vrste kao `parts`, zatvoren popis istim redom: `typed`, `assistant_inserted`, `assistant_match`, `imported_file`, `pasted_known`, `pasted_unknown`.
- Nema teksta, tipke, vremena unosa, brzine ni izvedene mjere.
- Isti odgovor za studenta vlasnika i za čitatelje rada (nastavnik kolegija, nastavnik seminarske grupe, mentor), kao `work.origin-composition.get` (C-23, `app.origin_work_access`).

## Ruta `work.origin-segments.get`

`GET /api/v1/works/{documentId}/origin-segments[?revision=n]`, pristup `owner_or_course_teacher`.

```
200 {
  revision: integer | null,            // revizija kojoj rasponi pripadaju; null kad nijedna nije zapisana
  segments: [                          // najviše 10000, redom kako su zapisani
    { blockId, start, end, kind, segmentRef }
  ]
}
```

| Polje        | Značenje                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `blockId`    | ID bloka revizije (`isNodeId`, UUID verzije 1 do 8)                                                               |
| `start`      | prva točka (code point) raspona u tekstu bloka iz `textBlocksOf`, od 0                                            |
| `end`        | točka iza zadnje (isključivo), veća od `start`, najviše 10 000 000                                                |
| `kind`       | vrsta iz zatvorenog popisa; raspon vezan uz promjenu koju je student naknadno objasnio čita se kao `pasted_known` |
| `segmentRef` | `segmentRef` koji je klijent poslao u `work.assistant-match.post` za taj tekst, inače `null`                      |

- **Revizija:** bez `?revision` vraćaju se rasponi zadnje zapisane revizije; s `?revision=n` rasponi zadnje zapisane revizije koja je ≤ n. `revision` u odgovoru kaže koja je to revizija, pa klijent zna odgovaraju li rasponi tekstu koji prikazuje.
- **Razrješavanje nalaza podudaranja:** nalaz iz `work.assistant-match.get` nosi `segmentRef`; svi rasponi s istim `segmentRef` su njegov položaj (jedan `segmentRef` može pokriti više blokova).
- Rasponi istog bloka se ne preklapaju (smiju se dodirivati).
- Greške: 401 `unauthorized`; 404 `not_found` (tuđi, nepoznat ili neispravan rad, isti odgovor); 422 `invalid_input` (upit koji nije točno `?revision=n`, n cijeli broj od 0 do 2^53−1); 503 `unavailable` (i za redak koji ugovor ne dopušta).

## Ruta `work.origin-segments.post`

SRV-KARTA-RASPON-RUTA (Ductus#2055, varijanta A; API 1.115.0). `POST /api/v1/works/{documentId}/origin-segments`, pristup `student_owner`, zaštita mutacije kao ostale POST rute (origin, `sec-fetch-site`), `application/json`, tijelo najviše 2 MiB.

```
{ revision: integer,                  // revizija koju je student spremio
  segments: [                         // 1 do 10000
    { blockId, start, end, kind, segmentRef?, changeId? }
  ] }
201 { revision, recorded }            // recorded = broj zapisanih raspona
```

- Upisuje samo student vlasnik rada. Nastavnik, mentor i bilo tko drugi dobivaju 404 kao za nepoznat rad; rasponi se čitaju samo kroz `work.origin-segments.get`.
- Jedan upis po reviziji; drugi upis iste revizije je 409 `conflict` i ništa ne mijenja.
- 422 `invalid_input`: tijelo koje nije točno ovo, prazan raspon (`end` ≤ `start`), revizija koju student nije spremio, `pasted_known` bez `changeId` ili `changeId` druge vrste ili drugog rada, preklapanje raspona istog bloka.
- Ostale greške: 401 `unauthorized`, 415, 400 `invalid_json`, 413, 408, 403 (zaštita mutacije), 503 `unavailable`.

## Pohrana

Migracija `20261218100000_origin_segments.sql`:

- `evidence.origin_segment`: jedna snimka po (rad, revizija), samo dodavanje (okidač odbija `UPDATE`, `DELETE`, `TRUNCATE`), vlasnik uloga evidencije, `ENABLE` i `FORCE ROW LEVEL SECURITY`, nijedna druga uloga nema pravo na tablicu. Strani ključ na `evidence.document_revision`: raspon postoji samo za spremljenu reviziju.
- `app.work_origin_segments_record(document, revision, segments jsonb)`: samo student vlasnik (`app.origin_work_access(…, true)`), jednom po reviziji (drugi put ZD409), za reviziju koju je on spremio. Element je zatvoren skup ključeva `{blockId, start, end, kind, segmentRef?, changeId?}`. `pasted_known` samo uz `changeId` promjene te vrste; `changeId` mora biti promjena istog rada iste vrste. Sve ostalo ZD422.
- `app.work_origin_segments(document, revision)`: vlasnik i čitatelji, ZD403 za sve ostalo, ZD401 bez sesije.
- pgTAP: `db/main/tests/246-origin-segments.sql` i retci u `030-institution-access-matrix.sql`.

## Poznate granice

- Rasponi su ono što je klijent zabilježio, kao i `work_origin_record` (SRV-0910): poslužitelj provjerava oblik, vlasništvo, spremljenu reviziju i nepreklapanje, ali ne uspoređuje raspone s tekstom revizije (granice bloka nisu provjerene na poslužitelju).
- Upis raspona ide rutom `work.origin-segments.post` (SRV-KARTA-RASPON-RUTA). Upis promjena podrijetla iz SRV-0910 još nema HTTP rutu, pa `changeId` (i time `pasted_known`) klijent za sada ne može dobiti.
- Tijelo je ograničeno na 2 MiB, pa 10000 raspona stane samo kad su kratki (oko 200 bajtova po rasponu).
- Prazna revizija nema snimku (najmanje jedan raspon), pa za nju čitanje vraća prethodnu zapisanu reviziju; `revision` u odgovoru to pokazuje.
