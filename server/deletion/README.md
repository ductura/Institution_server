# server/deletion

Područje iz [karte servera](../../docs/server-map.md). Za sada ima jedan servis: potpisanu kontrolnu točku evidencije brisanja (SRV-1302; plan M10.0-S1, D-272 MQ07). Ruta nema.

## Što radi

Brisanje po klasi podataka i roku čuvanja, uključujući verzije objekata. Feature područje: logika rute ili posla je u `service`.

Danas: `DeletionService.checkpointErasures` iz niza nadgrobnih zapisa jedne ustanove (`evidence.erasure`, SRV-1301) gradi kontrolnu točku evidencije brisanja i sprema je.

- Lanac SHA-256 nad zapisima redom kojim ih pozivatelj preda: svaka karika hashira prethodnu glavu i cijeli zapis u JCS obliku (`erasure-checkpoint.ts`). Lanac nad nijednim zapisom počinje od `ERASURE_CHAIN_GENESIS`.
- Kontrolna točka (`ductura.erasure-checkpoint.v1`) sadrži ustanovu, broj zapisa, glavu lanca te ID i vrijeme zadnjeg zapisa. Nema sata ni slučajnosti, a Ed25519 je deterministički, pa isti zapisi uvijek daju iste bajtove.
- Potpis je Ed25519 portom ključeva, nad fiksnim kontekstom i JCS tekstom sadržaja. Prije spremanja servis provjeri kontrolnu točku ključem koji port navodi; pogrešan ključ ili potpisnik ne sprema ništa.
- Spremanje ide kroz port `external/storage` (`putImmutable`) pod `v2/<ustanova>/erasure-checkpoint/<sha256>.json`: objekt adresiran hashom, nikad prepisan, pa ponovljena ista kontrolna točka daje `existing`. Pravi bucket kontrolnih točaka (B0.1) nije dio ovog koraka; testovi koriste lažnu pohranu.
- `verifyErasureCheckpoint(checkpoint, records, publicKey)` prima spremljene bajtove ili potpisani objekt i vraća `{ ok: true }` ili zatvoreni kod (`ErasureCheckpointProblem`). Izmijenjen, izbačen, dodan ili premješten zapis ruši provjeru. Ni odgovor servisa ni odgovor provjere ne sadrže ulazne podatke.

## Tko ga zove

`http` kao sastavljač i planirani posao zadržavanja (M10.0-S2, pg-boss u workeru), kad postoji. Pozivatelj čita nadgrobne zapise kroz port baze i predaje ih redom; servis ne čita bazu ni sat. Provjeru zove proba povrata (M10.Z1) prije otvaranja povrata.

## Koje podatke dira

Objekte kontrolnih točaka u pohrani, samo kroz port `external/storage`. Glavnu bazu ne dira izravno: zapise mu predaje pozivatelj.

## Što izvozi

- `createDeletionService`, `DeletionService`, `ErasureCheckpointSigner`, `ErasureCheckpointBuild`, `ErasureCheckpointBuildProblem`, `StoredErasureCheckpoint`, `ERASURE_CHECKPOINT_OBJECT_GROUP` (`service.ts`);
- `verifyErasureCheckpoint`, tipovi zapisa i kontrolne točke, zatvoreni popisi `ERASURE_DATA_CLASSES` i `ERASURE_REASONS` te granice (`erasure-checkpoint.ts`);
- `DELETION_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `DELETION_SCHEMAS`: sheme, za sada prazne (`schemas.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `contracts`, `database`, `external/storage` i `external/email`, i to kroz njihov `index.ts`. `database`, `external/storage` i `external/email` uvozi samo s `import type` (tip porta); adapter mu predaje sastavljač (danas `http`). `external/keys` nije na popisu: tip potpisnika (`ErasureCheckpointSigner`) je opisan tipovima iz `domain`, a `SigningKeyProvider` mu odgovara. Ne uvozi `http` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju provodi lint `local/area-boundary`.
