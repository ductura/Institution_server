# test-support/shutdown-entry

Testni ulaz integracijskog testa gašenja ([server/server-shutdown.integration.test.ts](../../server/server-shutdown.integration.test.ts)), S-1B-c (DAN-778), odluka orkestratora c.6893347945 (0) A.

Pokreće iste `startServer` i `installShutdown` iz `server/http` kao `server/server.ts`, ali s jednom sporom rutom, jer pravi ulaz nema rutu koja traje. Argumenti su `<slow ms> <hook>`: `GET /api/v1/health?slow` čeka zadane milisekunde i onda na stdout piše `{"event":"route.done"}`, `GET /api/v1/health?big` odgovara tijelom od 5 MB, a `hook` (`ok`, `throw`, `hang`) daje kuku nakon zapisa. Rok je `SHUTDOWN_GRACE_MS`. Sve vrijednosti su izmišljene.

Ne ide u build, ne izvozi se i proizvodni kod ga ne uvozi.
