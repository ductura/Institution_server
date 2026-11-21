# server/contracts/import

Ugovor uvoza (SRV-1801, plan M8.0-S1, D-290 do D-292). Odluka i plan napada: [docs/adr/import-contract.md](../../../docs/adr/import-contract.md). **PRIJEDLOG do reviewa;** uvoz se ovdje ne gradi.

- `manifest.ts`: manifest `ductus-import-manifest-v1`, tri hasha, kanonski tekst i provjera B3;
- `import-event.ts`: zapis `import_event` i mentorova projekcija;
- `file-name.ts`: normalizacija naziva datoteke (izvan svakog hasha);
- `limits.ts`: granice čitanja (samo se pooštravaju);
- `package-rules.ts`: makroi, ugrađeni objekti, vanjske poveznice i kodovi odbijanja čitanja;
- `confirmation.ts`: idempotentna potvrda pregleda i oblik na žici.

Uvozi samo `@sinclair/typebox`. Golden vektori u `golden-vectors/` bajt su po bajt isti kao u Ductusu i ne generiraju se iz koda pod testom.
