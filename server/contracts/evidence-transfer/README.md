# server/contracts/evidence-transfer

Zajednički ugovor dokaza za uvoz i prijenos iz AI pomoćnika (SRV-1809, plan M9.0-S1, D-269 O8). Proširuje ugovor uvoza [SRV-1801](../import/README.md); izvor je Ductus `docs/contracts/evidence-segment-v4.md`. **PRIJEDLOG do reviewa ugovora;** ovdje se ne grade tablica, RPC ni ruta.

Format odsječka ostaje `ductus-evidence-segment-v4` iz [`server/domain/forensics`](../../domain/forensics/README.md); `evidence-receipt-v2` i formati v2 i v3 se ne mijenjaju. Ovdje je ono što odsječak navodi id-jem i hashom i što klijent i poslužitelj dijele:

- `ai-transfer.ts`: zapis `ductus-ai-transfer-v1` (zatvoren skup od 12 ključeva, bez sadržaja razgovora, uputa i prenesenog teksta, C11), kanonski JCS tekst čiji SHA-256 je `aiTransferSha256`, čitanje samo kanonskog teksta i provjera dopuštenog pružatelja, modela i svrhe pri stvaranju zapisa (C3, C4). Pružatelj i model su samo oblik; testovi koriste `provider-test-a` i `model-test-1` (Q-10).
- `transfer-link.ts`: jedan oblik veze događaja za `import`, `ai-transfer` i `pasteOrigin`, te provjera veze u transakciji commita i `reserve`. Svaki neuspjeh je `invalid`, pa se tuđi i nepostojeći zapis ne razlikuju (C7).
- `event-text.ts`: definicija teksta događaja (umetnuti rasponi redom koraka, bez normalizacije, K14), presuda o poznatom podrijetlu lijepljenja (`known` samo za neprekinut, bajtno točan podniz trenutnog teksta izvora; inače `not_observed`, nikad odbijanje), zapis presude bez teksta i hasha izvora (D9, E5) i prikaz u projekciji.

Uvozi samo `@sinclair/typebox` i obrasce iz [`../import`](../import/README.md). Ugovori ništa ne hashiraju: hash računa pozivatelj. Golden vektori u `golden-vectors/` izračunani su izvan koda pod testom (Python `json` i `hashlib`, A8).

Otvoreno: O-1 do O-7 iz Ductus #1659 i ugovora v4 (među njima O-5 `transferredAt` na minuti i O-6 `pasteOrigin` na `drop`); tablice, RPC-ovi, replay i bilježenje na klijentu zasebni su kritični koraci.
