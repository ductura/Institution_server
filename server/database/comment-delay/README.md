# comment-delay

Luka baze za odgođene komentare i oznaku zadnjeg pregleda (SRV-1703, migracija `20261129100200`). Svaki poziv je jedna `withActor` transakcija nad jednom RPC funkcijom sheme `collaboration`. Odgovor je zatvoren status (`unauthenticated`, `not_found`, `invalid`, `conflict`, `unavailable`), nikad poruka baze. Pravila su u bazi i dokazana su u `db/main/tests/201-comment-delay-bank.sql`.

`publishListed` u istoj transakciji čita nacrte, uspoređuje ih s navedenim id-jevima (bez obzira na velika i mala slova) i tek tada objavljuje; svaka razlika je `conflict` bez objave. Nacrti se čitaju kroz `list_comment_drafts`, pa ih bez migracije nije moguće zaključati. Nacrt nastao između čitanja i objave poveća broj objavljenih i vraća cijelu transakciju kao `conflict`; odbacivanje i novi nacrt u istom trenutku i dalje prolaze.
