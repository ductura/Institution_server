# SRV-8D `dorada-zahtjev-rok` (val 8, traka S-A uz migraciju S-B)

Risk: high. Mijenja ugovor i bazu; migracija samo na lokalnu i testnu bazu.

## 1. Izvor

- PLAN-MIGRACIJE.md, „Val 8” („novo: rok dorade u ugovoru (✓ C-8)”); Danielov odgovor C-8 „Rok dorade: Da”.
- Prototip: `INVENTAR-nastavnik.md` §3.7 (dijalog `dd-h`, polje `#f-ddr`, `doradaBanner`) i redak „N-07 rok za doradu” u tablici ugovora; `INVENTAR-editor.md` §2.5 mentor2 (`m2Back`: sažetak „Što treba doraditi” + „Rok”, runda se pri vraćanju ne povećava).
- Kod: `server/collaboration/revision-requests.ts`, ugovor `collaboration.revision-requests.post`, migracije 20261106160000..20261109210000 (stupci `version`, `requested_revision`; roka i runde nema).

## 2. Ugovor rute (PRIJEDLOG; prvo serverski PR s ugovorom, pa rukovatelj)

- Ista ruta `POST /api/v1/revision-requests/{action}`; `create` dobiva neobavezno `dueAt` (UTC cijela minuta, kao D-24); `list` red i odgovori `current` dobivaju `dueAt` i `round`.
- Izmjena je prošireno polje u zatvorenom tijelu (`closed`), pa je to nova verzija ugovora; stari klijenti bez `dueAt` ostaju valjani samo ako ga ugovor drži neobaveznim.
- Greške kao danas: 401, 403, 404, 409 `not_allowed`/`conflict`, 415, 422 `invalid_input` (rok u prošlosti, neispravan oblik), 503.

## 3. Kriteriji prihvata

- [ ] Migracija dodaje `due_at` (null dopušten) uz pgTAP retke matrice pristupa; student vidi rok svog zahtjeva, tuđi ne.
- [ ] `create` s rokom u prošlosti: 422; bez roka: kao danas.
- [ ] `accept`, `reopen`, `rereview` i `withdraw` ne mijenjaju rok; `list` ga vraća.
- [ ] Vektori, ponovno generiran ugovor, lažni poslužitelj i test razlike prema prethodnoj verziji ugovora (`breaking`).
- [ ] Nijedan postojeći test revision-requests nije obrisan ni preskočen.

## 4. Ovisnosti

- Ugovor (S-A) i migracija (S-B) idu prije rukovatelja; WEB-8C čeka spojen ugovor.

## 5. Otvorena odluka: ODLUKA ORKESTRATORA

- Je li rok polje zahtjeva `dueAt`, i je li „runda” brojač zahtjeva (`version`) ili zaseban broj po radu.
- Je li „vrati na doradu” za cijeli rad zahtjev s `anchor` bez mjesta ili nova radnja; danas ugovor traži `anchor`.
- Tko drži migraciju i ugovor (trake S-B i S-A), jer ih ova kartica ne smije dirati bez dodjele.
  Tekst „Vala 8” iz kanonskog plana pisac ima u kopiji `docs/plan/PLAN-MIGRACIJE.md`.
