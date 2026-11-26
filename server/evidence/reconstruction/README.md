# server/evidence/reconstruction

## Što radi

Kontrolne točke rekonstrukcije (SRV-1503, plan M3.3, B-12). Nakon svakih `RECONSTRUCTION_CHECKPOINT_INTERVAL` (50) prihvaćenih odsječaka worker sprema dokument koji je rekonstruirao, uz hash. Čitanje zadane revizije tada ponavlja samo odsječke nakon najnovije kontrolne točke prije nje, a ne cijeli niz.

Kontrolna točka je predmemorija koju zapis jamči, nikad samostalan dokaz:

- mora stajati na položaju ovog zapisa (odsječak na toj reviziji nosi njezin hash odsječka);
- njezini bajtovi moraju imati hash ključa i hash `finalDocumentHash` tog odsječka;
- moraju biti točno kanonski oblik dokumenta koji replayer učita.

Kontrolna točka koja ne prođe neku od provjera (oštećena, tuđeg zapisa, iza tražene revizije) ne koristi se: čitanje pada na puni niz i u `fallback` kaže zašto. I replay iz ispravne kontrolne točke koji ipak padne vraća se na puni niz, pa je odgovor uvijek onaj koji daje cijeli zapis.

## Tko ga zove

Worker, nakon što provjeri lanac odsječaka (verifyEvidenceChainV2) i potvrde. Petlja je `server/worker/reconstruction/` (F4-PM2-R02): za svaki dospjeli paket zove `createPackageCheckpointRecorder` (`package-pass.ts`), koji čita lanac (`chain-source.ts`, RPC `app.worker_packages_due_checkpoints` i `app.worker_package_chain`), objekte odsječaka iz pohrane ustanove, provjerava ih prema glavi paketa (`verifyEvidenceChainV2`; lanac s prekidom ili objekt koji nije pod svojim hashom se preskače) i tek tada zove `recordDueCheckpoints`. Revizija 0 i odabir replayera dolaze iz `schemaVersion` početnog teksta.

## Koje podatke dira

`evidence.reconstruction_checkpoint` (migracija `20261127100000_reconstruction_checkpoint.sql`), samo kroz RPC-e `app.worker_reconstruction_checkpoint` i `app.worker_record_reconstruction_checkpoint` vlastite domene dokaza workera. Tablica je samo za dodavanje; student svoje kontrolne točke čita kroz `app.read_own_reconstruction_checkpoint`.

## Što izvozi

`readDocumentAtRevision`, `buildReconstructionCheckpoints`, `verifyReconstructionCheckpoint`, `checkpointRevisionsDue`, `readPackageRevision`, `recordDueCheckpoints`, `createWorkerReconstructionCheckpointStore`, `createWorkerEvidenceChainSource`, `createPackageCheckpointRecorder` i njihove tipove (`index.ts`).

## Što ne smije uvoziti

HTTP sloj, sesiju ni prijavu. Ne uzima osobu ni ustanovu kao parametar: domena dokaza je konfiguracija workera, a paket određuje dokument, ustanovu i osobu u bazi.
