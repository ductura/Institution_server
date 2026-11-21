# server/evidence/daily-root

Potpisani dnevni korijen evidencije i njegov posao u rasporedu workera (SRV-1311; plan M3.9, B5; D-72 odlučen u D-209).

## Što radi

- `dailyRootOf(entries)` računa Merkle korijen nad unosima evidencije jednog UTC dana postojećim stablom `evidence-log-merkle` (D-93, RFC 9162): list je `SHA-256(0x00 ‖ D)`, gdje je `D` 32-bajtni digest potvrde, a redoslijed je `acceptedAt` uzlazno pa UTF-8 bajtovi `receiptId`. Isti unosi daju isti korijen bez obzira na redoslijed kojim stignu. Dan bez unosa ima korijen praznog stabla (`SHA-256` bez bajtova).
- Zapis dana je `{ day, root, count, keyId, signature }` (`DailyRootRecord`). Potpis je čisti Ed25519 portom ključeva nad `UTF-8("ductura.evidence-daily-root.v1") ‖ LF ‖ JCS({ day, root, count, keyId })`, pa izmjena bilo kojeg od četiri polja ruši potpis. Spremljeni oblik je JCS tekst zapisa.
- `verifyDailyRoot(record, entries, publicKey)` vraća `{ ok: true }` ili zatvoreni kod (`DailyRootProblem`): izmijenjen unos daje `root_mismatch`, izbačen ili dodan `count_mismatch`, unos drugog dana `entry_outside_day`, krivi ključ `signature_invalid`. Potpis se provjerava prvi. Odgovor nikad ne sadrži ulazne podatke.
- `dailyRootJob(deps)` je posao `evidence_daily_root` jednom dnevno (termin od ponoći UTC). Termin koji počinje u ponoć dana D zatvara dan D-1. `candidates` (probni prolaz) samo broji unose; `execute` gradi zapis, provjerava ga ključem koji port navodi i tek onda sprema. Dan bez unosa sprema zapis s `count: 0` i ne ruši posao.
- Spremanje ide kroz port `external/storage` (`putImmutable`) pod `v2/<ustanova>/evidence-daily-root/<sha256(format ‖ LF ‖ dan)>.json`: jedan objekt po danu, nikad prepisan. Drugo izvođenje istog termina daje iste bajtove i odgovor `existing`; drukčiji zapis za već spremljen dan je `daily_root_conflict` i ništa ne mijenja.

## Tko ga zove

Ulazna točka workera (planirana, VS-1b) registrira posao s `registerDailyRoot(registerScheduledJob, deps)` i predaje mu čitač unosa iz baze, potpisni port i pohranu, kao `registerPurgeEndedSessions` u `server/session/purge-ended`. Dok posao nije na popisu `EXECUTE_ALLOWED` rasporeda (`server/database/queue/schedule`), raspored ga izvodi kao probni prolaz. Provjeru izvan mreže i baze radi CLI `scripts/evidence-verify`.

## Koje podatke dira

Samo objekte dnevnih korijena u pohrani, kroz port `external/storage`. Bazu ne čita izravno: unose mu daje čitač (`DailyRootEntriesReader`) koji predaje sastavljač.

## Što izvozi

`createDailyRootService`, `dailyRootJob`, `registerDailyRoot`, `dailyRootDay`, `dailyRootObjectHash`, `DailyRootError`, `verifyDailyRoot`, `dailyRootOf`, `dailyRootPayload`, `dailyRootSigningInput`, `dailyRootPublicKey`, `encodeDailyRoot`, čitače zapisa i unosa, konstante (`DAILY_ROOT_FORMAT`, `DAILY_ROOT_JOB`, `DAILY_ROOT_EVERY_MS`, `DAILY_ROOT_OBJECT_GROUP`, `MAX_DAILY_ROOT_ENTRIES`, `MAX_DAILY_ROOT_RECORD_BYTES`, `DAY_MS`) i tipove (`index.ts`).

## Što ne smije uvoziti

Kao područje `evidence`: `domain` i tip porta `external/storage` (samo `import type`). Ne uvozi `external/keys` (potpisnik je opisan tipovima iz `domain`, `SigningKeyProvider` mu odgovara) ni mapu reda `server/database/queue` (oblik definicije posla je napisan ovdje, `registry-boundary.test.ts`).
