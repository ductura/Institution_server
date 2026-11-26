# OPS-OPTERECENJE: test opterećenja „150 studenata predaje u zadnjih 10 minuta”

Plan: ductura/.github#104 (`docs/plan/PRIJEDLOZI-2611.md`); odobrio Daniel 26. 11. 2026. (Ductus#2055 c.7182294468). Opseg po nalogu orkestratora: **samo scenarij i skripta**. Ništa se ne pokreće na stagingu ni na drugom okruženju (staging tek nakon F4, odluka vlasnika). Skripta nije pokrenuta ni lokalno; provjerena je samo kako piše u „Što je provjereno”.

## Datoteke

- `docs/nalazi/ops-opterecenje/k6.ts`: k6 skripta (scenarij, metrike, pragovi).
- `docs/nalazi/ops-opterecenje/segment.ts`: gradi izmišljene zahtjeve `evidence.commit` (segment `ductus-evidence-segment-v2` u kanonskom obliku i kanonski dokument); bez k6 uvoza, pa radi i pod Nodeom.

## Scenarij

Jedan virtualni korisnik (VU) je jedan student; 150 VU-ova, svaki točno jedan prolaz. Prozor je 600 s.

1. **Otvaranje** (0–60 s): `POST /api/v1/evidence/open` (`start: true`); počeci su raspoređeni jednoliko kroz prvu minutu da otvaranje nije jedan skok.
2. **Spremanje i potpis**: `SAVES_PER_STUDENT` (zadano 6) puta `POST /api/v1/evidence/commit`, svako u svom odsječku raspona 60 s do (prozor − 90 s), u apsolutno zadanim ciljnim vremenima (jitter se ne zbraja, kasni odgovor skraćuje sljedeće čekanje). Svaki odgovor mora nositi potpisanu potvrdu (`receipt.status = "signed"`); revizija i `headSegmentHash` za sljedeći korak uzimaju se iz odgovora.
3. **Predaja** (između (prozor − 60 s) i (prozor − 10 s)): `POST /api/v1/submission/v2` s `documentId` i zadnjom revizijom.

Zahtjevi nose zaglavlja kao vektori ugovora: `Origin` (= `APP_ORIGIN` servera), `Sec-Fetch-Site: same-origin`, `Ductus-Protocol: 1` i kolačić sesije.

## Pokretanje (kad vlasnik odobri okruženje)

```sh
k6 run -e BASE_URL=<podrijetlo servera> -e SESSIONS_FILE=<putanja do JSON-a> docs/nalazi/ops-opterecenje/k6.ts
```

| Varijabla           | Značenje                                                                                                                       | Zadano                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `BASE_URL`          | podrijetlo servera pod testom (obavezno, nije u repou)                                                                         | –                       |
| `SESSIONS_FILE`     | JSON `[{ "cookie": "<vrijednost sesije>", "assignmentId": "<uuid>" }, …]`, najmanje `STUDENTS` unosa (obavezno, nikad u repou) | –                       |
| `APP_ORIGIN`        | vrijednost zaglavlja `Origin`                                                                                                  | `BASE_URL`              |
| `STUDENTS`          | broj studenata (VU-ova)                                                                                                        | 150                     |
| `WINDOW_SECONDS`    | trajanje prozora                                                                                                               | 600                     |
| `SAVES_PER_STUDENT` | broj spremanja po studentu                                                                                                     | 6                       |
| `COOKIE_NAME`       | ime kolačića sesije                                                                                                            | `__Host-ductus_session` |

Sesije se pripremaju odvojeno od mjerenja (prijava izmišljenih `demo-*` računa kroz staging način lažnog OIDC-a, D-09); skripta ne prijavljuje studente i ne zna ni za jedan račun. Svaki student mora imati vlastiti otvoren rad na zadatku (`assignmentId`), a rokovi zadatka moraju trajati kroz cijeli prozor.

## Mjere i pragovi

| Mjera                      | Prag (pretpostavka)                     |
| -------------------------- | --------------------------------------- |
| `ops_open_ms` p95          | < 2000 ms                               |
| `ops_save_ms` p95 (commit) | < 1500 ms                               |
| `ops_submit_ms` p95        | < 3000 ms                               |
| `http_req_failed`          | < 1 %                                   |
| `ops_receipt_not_signed`   | < 1 % (spremanje bez potpisane potvrde) |
| `ops_student_failed`       | 0 (student kojem je neki korak pao)     |

Uz to izvještaj bilježi `ops_submitted` (očekivano = `STUDENTS`) i p95/p99 po imenu rute (oznaka `name`: `evidence.open`, `evidence.commit`, `submission.submit-second`).

## Što je provjereno

- `segment.ts` je pokrenut pod Nodeom nad vektorom `server/contracts/vectors/evidence.open.post.json`: tri uzastopna zahtjeva daju segmente koje prihvaća `isEvidenceSegmentV2` iz repoa, hash otvorenog dokumenta se podudara, `finalDocumentHash` jednak je SHA-256 poslanog dokumenta, a `initialDocumentHash` sljedećeg koraka jednak je prethodnom završnom. SHA-256 segmenta jednak je `segmentHash` iz potvrde u vektoru.
- `node --check` nad `k6.ts`.

## Pretpostavke

- Skripta podržava samo radove s dokumentom verzije 1 ili 2 (format koraka `ductus-edit-steps-v1`, `evidenceTransactionFormatOfWork`); rad verzije 3 ili 4 student se broji kao pao (`ops_student_failed`) uz poruku. Pripremljeni radovi moraju biti verzije 1 ili 2.
- Dokument se kodira i dekodira kao UTF-8 (hrvatski znakovi i emoji u postojećem dokumentu ne kvare hasheve).
- Plan imenuje p95 i greške, ne brojke: pragovi iznad su moji i vlasnik ih može promijeniti u `options.thresholds`.
- Predaja ide kroz `submission/v2` (druga verzija operacije, SRV #646); `submission` (v1) ostaje izvan scenarija.
- Svaki commit nosi jedan događaj (`segments` ugovor dopušta točno jedan odsječak) i dodaje ASCII tekst na kraj prvog odlomka.
- Potpis u scenariju je serverski (potpisana potvrda u odgovoru commita), ne zaseban zahtjev.

## Otvoreno

- **150 računa**: seed ima samo nekoliko `demo-*` računa; 150 izmišljenih studenata upisanih na zadatak i njihove sesije treba pripremiti odvojeno (zaseban zadatak, izvan `docs/nalazi/`). Skripta ne stvara račune.
- **k6 nije instaliran** u okruženju pisca, pa skripta nije izvedena ni na lokalnom stogu; prvo izvođenje (lokalno, pa staging nakon F4) i brojke ostaju za odobreno okruženje.
- Replay i verifikacija lanca na serveru nisu izvedene (nema baze); provjerena je samo valjanost oblika i hash lanca kako je gore navedeno.
