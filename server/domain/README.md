# server/domain

Područje domene (karta: [docs/server-map.md](../../docs/server-map.md)): čista pravila i modeli bez I/O-a, SQL-a i vendor SDK-ova. Prenesen iz Ductusa na `d52a92c3` (S-0.19, DAN-732) bez promjene logike; izmjene su samo uvozi (`.ts`, preko `index.ts`), tipovi pod strožim `tsconfig.json` (`!` gdje Ductus ne traži provjeru indeksa) i imena koja traži lint.

| Mapa                                     | Iz Ductusa                        | Što je                                                                                  |
| ---------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| [forensics](forensics/README.md)         | `src/domain/forensics`            | JCS, segmenti dokaza v2 do v4, lanac, kontrolne točke, potvrde, potpisi, testni vektori |
| [evidence](evidence/README.md)           | `src/domain/evidence`             | Osnova dokaza (tvrdnja, izvor, izvadak) i omotnica `commit` zahtjeva                    |
| [document](document/README.md)           | dio `src/domain/document`         | Kanonski model dokumenta i koraci uređivanja koje forensics provjerava                  |
| [collaboration](collaboration/README.md) | `src/domain/collaboration/anchor` | Sidro u tekstu koje osnova dokaza koristi                                               |
| [json](json/README.md)                   | `src/domain/json.ts`              | Zajednički JSON tipovi i provjere                                                       |
| [settings](settings/README.md)           | — (novo, S-1J-f)                  | Katalog postavki po razinama (D-298) i provjera pisanja                                 |
| [jobs](jobs/README.md)                   | `src/application/jobs/job-body`   | Tijelo posla u redu: samo identifikatori (D-74), na `333e163` (DAN-820)                 |
| [assignment](assignment/README.md)       | `src/domain/assignment`           | Jezik rada: zatvoreni skup i parser, na `4651a25` (DAN-909)                             |
| [profile](profile/README.md)             | `src/domain/profile`              | Tijelo postavke jezika sučelja: skup i parser, na `51a062e` (DAN-851-1a)                |

`result.ts` drži zajedničke tipove `Result<T>` i `AppError` (`{ code, messageKey }`, [docs/CODE_STYLE.md](../../docs/CODE_STYLE.md) §8); samo tipove, bez I/O-a.

`index.ts` izvozi sve mape i `result.ts`. `SourceId` je iz `document`; istoimeni tip osnove dokaza izvozi se kao `EvidenceSourceId`.

Mapa ne uvozi ništa izvan sebe (karta §2: `domain` → —); uvozi su samo `node:crypto` i, u testovima, `node:fs`, `node:path`, `vitest` i `fast-check`.
