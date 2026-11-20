# Prilozi izvora

Port priloženih isječaka uz izvor rada (SRV-1102, Ductus#2051, val 11, editor E§3.4 „proofs”, B-8; migracija `20261121100000_source_proof.sql`). Prilog je isječak koji student priloži uz izvor svog rada: JPEG stranice (fotografija, zalijepljena slika ili izrez iz PDF-a koji ne napušta preglednik), stranica izvora i neobavezna bilješka. Prilog je „priložio student”: Ductura ne tvrdi da izvor kaže ono što student piše i ništa ne uspoređuje. Prilog nije evidencija, izvan je dokumenta i njegova hasha.

## Što radi

`createSourceProofs(withActor)` daje tri poziva, svaki u jednoj transakciji kroz RPC, nikad izravno u tablicu:

- `list(token, assignmentId, sourceId)`: prilozi jednog izvora vlastitog rada, najstariji prvi (`institution.source_proofs`);
- `add(token, input)`: student rada prilaže isječak uz izvor svog rada (`institution.add_source_proof`); upisani redak potvrđuje se unutar transakcije;
- `image(token, assignmentId, sourceId, proofId)`: bajtovi jednog priloga (`institution.read_source_proof_image`); prilog se imenuje radom, izvorom i ID-om zajedno.

Ulaz se provjerava prije baze kao u RPC-u: stranica 1 do 30 znakova, bilješka 1 do 2000 (smije imati prijelome redaka), bez kontrolnih znakova i razmaka na krajevima; slika mora biti JPEG (počinje s `FF D8 FF`, završava s `FF D9`) od najviše 1 MiB. Cijeli PDF ili druga datoteka odbija se kao `invalid_input`. Ishodi su vrijednosti, ne iznimke: ZD401 `unauthorized`, ZD403 `not_found` (jedan odgovor za svako odbijanje, C-23), ZD422 `invalid_input` (i granica od 200 priloga ili 100 MiB po radu); sve ostalo se baca.

## Tko ga zove

`server/http/source-proofs` preko `server/database/index.ts`.

## Koje podatke dira

Tablicu `institution.source_proof` glavne baze, samo kroz tri RPC-a gore. Student i ustanova dolaze samo iz sesije. Ovlasti i oblik u bazi pokriva `db/main/tests/160-source-proof-access.sql`; adapter pokriva `source-proofs.test.ts`.

## Što izvozi

`createSourceProofs`, `isSourceProofJpeg`, `isSourceProofText`, granice `SOURCE_PROOF_*` i tipove `SourceProof`, `SourceProofInput`, `SourceProofList`, `SourceProofAdd`, `SourceProofImage`, `SourceProofs`.

## Što ne smije uvoziti

Ništa osim tipa `WithActor` iz `server/database` (karta servera).
