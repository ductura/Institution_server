# scripts/locales

- `source-digest.ts`: iz Ductus checkouta ponovno računa SHA-256 tekstova `messages.hr.ts` i `messages.en.ts` i uspoređuje ih s `SOURCE_DIGESTS` u [locales/source.ts](../../locales/source.ts) (S-1L.1, DAN-768). Reviewer tako provjerava da je prijenos kataloga doslovan, bez povjerenja u zapisane konstante: `git -C <ductus> checkout d52a92c3a108f3f0ec9c3639188a2ea669bba582`, zatim `pnpm tsx scripts/locales/source-digest.ts <ductus>`. Izlaz 1 kad se digest razlikuje.
- `index.ts`: javno sučelje mape.

Test `source-digest.test.ts` gradi izmišljeni checkout u privremenoj mapi; ne treba Ductus ni mrežu.
