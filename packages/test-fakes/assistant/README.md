# Lažni lokalni AI pružatelj (SRV-FAKE-AI-LOKALNO)

`@ductura/test-fakes/assistant`: lažni pružatelj iza postojećeg porta asistenta (`server/domain/assistant/port.ts`). Bez tajni, bez ključa, bez mrežnih poziva, bez plaćenog API-ja. Odgovori su deterministički iz izmišljenih rečenica (isti odlomak i svrha, isti bajtovi). Pružatelj i model su izmišljeni (`fake-local-ai`, `fake-local-model-1`) i prolaze `PROVIDER_ID_PATTERN` i `MODEL_ID_PATTERN`; `FAKE_AI_PROVIDER_ENTRY` prolazi `parseProviderEntry`.

## Kako Graditelj pali lokalno

1. Samo lokalno: `NODE_ENV` nepostavljen, `development` ili `test`.
2. Izričito uključi: `DUCTURA_FAKE_AI_LOCAL=1`. Bez toga fake ne postoji (`fakeAiFromEnv` vraća `null`); nikad nije zadan. S drugom vrijednošću od `1` također je isključen.
3. U kodu lokalnog stoga: `const port = fakeAiFromEnv(process.env)`; `null` znači asistent ostaje `ai_disabled`. Ako `DUCTURA_FAKE_AI_LOCAL=1` stigne uz `NODE_ENV=production`, poziv baca grešku.
4. Za pružatelja u konfiguraciji ustanove upiši `FAKE_AI_PROVIDER_ENTRY`; zahtjev s drugim `modelId` fake odbija kao `provider_error`.

Produkcijski `server/` ne smije uvoziti paket (lint `local/no-fake-server-import`, `boundary.test.ts`), pa se fake ne montira u `server.ts`; montira ga lokalni stog koji već koristi `@ductura/test-fakes`.

## Načini i oznake

`createFakeAi({ mode, actualMicro, delayMs, timeoutMs, signal })`: `answer` (zadano), `refuse` (`provider_error`), `timeout`, `aborted`. `delayMs` veći od `timeoutMs` daje `timeout`; prekid `signal` daje `aborted`. Cijena je `0n` ako je ne zadaš (fake ne izmišlja iznose).

Na pokrenutom stogu isti ishod dobiješ tako da odlomak počne oznakom: `#odbij`, `#istek`, `#prekid`. Oznaka se čita samo iz odlomka i utječe samo na ovaj fake.
