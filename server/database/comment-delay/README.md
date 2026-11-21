# comment-delay

Luka baze za odgođene komentare i oznaku zadnjeg pregleda (SRV-1703, migracija `20261129100200`). Svaki poziv je jedna `withActor` transakcija nad jednom RPC funkcijom sheme `collaboration`. Odgovor je zatvoren status (`unauthenticated`, `not_found`, `invalid`, `conflict`, `unavailable`), nikad poruka baze. Pravila su u bazi i dokazana su u `db/main/tests/201-comment-delay-bank.sql`.
