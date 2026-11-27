# Radnik

Pozadinski proces Ducture (ARCHITECTURE §2: web i radnik dijele module, a svaki ima svoj sastavljač). Prvi dio je potpis potvrda koje čekaju potpis (`signing/`, SRV-1502, plan M3.2, B-9, D-210), drugi upis kontrolnih točaka rekonstrukcije (`reconstruction/`, F4-PM2-R02, plan M3.3, B-12).

## Što radi

- `signing/`: radnik koji potpisuje potvrde u stanju `pending_signature` (protokol 2, odgovor `202 pending_signature`) i oporavlja one koje je ostavio radnik koji je pao usred potpisa. Prvi prolaz nakon pokretanja obuhvaća svaku takvu potvrdu, zatim prolaz svakih `intervalMs`. Svaki prolaz piše jedan strukturirani zapis s brojem potvrda koje još čekaju potpis.
- Potpis iste potvrde uvijek su isti bajtovi (Ed25519 je deterministički, ulaz potpisa određuje spremljeni tekst), a spremište čuva prvi potpis (`already_signed` za svaki sljedeći), pa ponovljeni prolaz nakon pada nikad ne daje drugu potvrdu.
- `reconstruction/`: radnik koji svakih `intervalMs` pita bazu koji paketi imaju lanac dug barem jedan interval (50 odsječaka) bez kontrolne točke na najnovijoj dospjeloj reviziji i za svaki poziva `createPackageCheckpointRecorder` (`server/evidence/reconstruction/`): čita lanac i objekte odsječaka, provjerava ih prema glavi paketa pa tek onda `recordDueCheckpoints`. Prolaz ide po ID-u paketa, najviše `maxPackages` po prolazu, i piše jedan zapis (`worker.reconstruction_checkpoints.pass`) samo s brojevima. Baza (RPC `app.worker_packages_due_checkpoints`, `app.worker_package_chain`, migracija `20261220370000`) vraća samo ID paketa, ustanovu, broj odsječaka, hasheve i početni tekst.
- `submission-verdict/`: radnik koji nakon predaje (ruta predaje ostaje sinkrona i nepromijenjena) još jednom rekonstruira predanu reviziju istim provjerama kao ruta i traži od baze da zabilježi presudu (`verified` ili `mismatch`); presudu daje baza usporedbom hasheva, nikad radnik. Prolaz piše jedan zapis samo s brojevima; nedostupna pohrana ili ključevi ne bilježe presudu pa se predaja pokušava u sljedećem prolazu (F4-PM2-R01). Student presudu čita na `GET /api/v1/student/assignments/{assignmentId}/submission-reconstruction`.

## Tko ga zove

Proces radnika (F4-PM2-R01B): `server/worker-main.ts` (izlaz `dist/worker.js`, `pnpm build`) pokreće sastavljač `server/http/worker-composition.ts` (`createWorkerProcess`), koji gradi sva tri radnika nad jednim poolom, jednim potpisnikom i jednom pohranom. Web proces (`server/server.ts`) ne gradi i ne pokreće radnika (D-71, D-102).

## Pokretanje procesa

`node --disallow-code-generation-from-strings dist/worker.js`. Konfiguracija samo iz okoline, bez zadanih vrijednosti i bez tajni u repou:

- `WORKER_DATABASE_URL`: prijava `ductus_worker` (uloga iz migracije `20261003210000_roles.sql`), pool `worker` u `server/database/registry.ts`; nikad prijava web procesa.
- `WORKER_EVIDENCE_DOMAIN_ID`: UUID dokazne domene koju proces poslužuje (konfiguracija, nikad polje zahtjeva).
- Potpisnik i pohrana kao u web procesu (`DUCTUS_KMS_*`, `EVIDENCE_STORAGE_DOMAINS`, razvojni potpisnik samo u razvoju i testu; `server/http/evidence-deps.ts`).

Pogrešna konfiguracija: jedan zapis `startup.refused` po varijabli (bez vrijednosti) i izlaz 78 (EX_CONFIG). SIGTERM ili SIGINT: nijedan novi prolaz, svaki radnik čeka prolaz koji je u tijeku, pool se zatvara, izlaz 0; što ostane do `SHUTDOWN_GRACE_MS` izlazi s 1. Produkcijsku tajnu i okruženje postavlja vlasnik pri deployu; ovaj proces nije u `render.yaml`.

Čitanje dokumenta paketa za kontrolne točke: shema dokumenta 1 (ili bez navedene) s koracima izmjene v1, kao predaja; paket druge sheme ostaje netaknut (`unsupported_document`).

## Koje podatke dira

Ništa izravno. Čita i piše samo kroz portove `database` (red potvrda, ključevi domene, upis potpisa, objekt odsječka, sve pod prijavom `ductus_worker`), `evidence` (provjera objekta, potpis jedne potvrde, prolaz) i `external/storage` (HEAD objekta). Zapis prolaza sadrži samo brojeve, nikad ID ni tekst potvrde.

## Što izvozi

`createReconstructionWorker` (uz `DEFAULT_RECONSTRUCTION_WORKER_CONFIG`, imena događaja i tipove), `createReceiptSigningWorker`, `DEFAULT_RECEIPT_SIGNING_CONFIG`, granice konfiguracije, imena događaja zapisa (`RECEIPT_SIGNING_PASS_EVENT`, `RECEIPT_SIGNING_FAILED_EVENT`), `passFields` i tipove.

## Što ne smije uvoziti

Ništa osim `log`, `database`, `evidence` i `external/storage` (docs/server-map.md §2), i to samo tipove iz `external/storage`. Ključ potpisa ne čita iz okoline ni datoteke: dobiva ga kao port potpisa, u testovima uvijek lažni.
