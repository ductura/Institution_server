# scripts/operations/restore-drill

Proba povrata baze i bucketa na vraćenom, lokalnom ili testnom stogu (plan M11.2-P04; D-277 NQ05). Nositelj probe po planu; M10.Z1 (`server/deletion/restore-drill/`) daje čistu provjeru koju ova skripta zove.

- Povrat se otvara samo ako se nadgrobni zapisi vraćene baze podudaraju s potpisanom kontrolnom točkom (M10.Z1). Inače: zatvoreno, kod problema.
- Zatim se vraćeni bucket uspoređuje s bazom: svaka stavka koja smije natrag mora biti u bucketu s istim hashom (`missing`, `mismatched`), a izbrisana stavka ne smije biti ponovno u bucketu (`resurrected`). Svaka razlika daje `bucket_differs`.
- Meta mora biti lokalna ili rezervirano testno ime (`localhost`, `127.0.0.1`, `*.invalid`, `*.test`, `*.localhost`); drugo daje `target_not_local`. Produkcija se iz agenta ne dira.
- Samo izmišljena ustanova (`5d5d5d5d-0000-4000-8000-…`). Ispis je zatvoren kod ili brojevi, nikad vrijednost iz ulaza.

## Pokretanje

`RESTORE_DRILL_TARGET=http://localhost:4000 RESTORE_DRILL_INSTITUTION=5d5d5d5d-0000-4000-8000-000000000001 node scripts/operations/restore-drill/cli.ts <mapa>`

Mapa: `checkpoint.json`, `public-key.json`, `tombstones.json`, `copy.json`, `bucket.json` (izvoz iz vraćene baze i bucketa). Izlaz 0 uspjeh, 1 zatvoreno ili razlika, 2 neupotrebljiv ulaz.

## Otvoreno

- **Stvarna proba (M10.Z2) nije izvršena**: traži staging i račune, što je radnja vlasnika. Skripta je provjerena samo testovima nad izmišljenim podacima.
- **Odluka Caddy/OpenTofu naspram Rendera (M11.2) nije donesena ovdje.** Pretpostavka do odluke vlasnika: ostaje Render (`render.yaml`, `docs/DEPLOY.md`), bez izmjena. Proba je neovisna o izboru jer čita izvoz iz vraćene baze i bucketa. R-8 (viša revizija nakon povrata, Ductus#87 c.6880906459) nije dio ove skripte.
