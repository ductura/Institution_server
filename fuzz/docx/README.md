# Fuzzing the DOCX import (ISTR-8)

One parser, `readDocx` (`server/import/docx`), under [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js)
4.0.0 (verified on Node 24). Not part of `pnpm test` or `ci-ok`.

```
cd fuzz/docx && pnpm install --frozen-lockfile --ignore-workspace   # once; own lockfile
node fuzz/docx/run.ts [seconds]                                     # default 60
```

Manual workflow: `.github/workflows/fuzz-docx.yml` (`workflow_dispatch`, input `seconds`).

- **Target:** `target.ts` calls `readDocx` with limits tighter than production and fails on an
  exception or on a code outside the import contract. Hangs are cut by `-timeout=5`, memory by
  `-rss_limit_mb=2048`, input size by `-max_len` (256 KiB), total time by the `seconds` argument.
- **Corpus:** the ISTR-6 fixtures (`test-support/docx-zip/mammoth`) and `regressions/*.bin`, copied
  to a scratch corpus in `dist/` (git-ignored); the run never writes into the repository.
- **A crash:** Jazzer writes `dist/crash-*` (or `timeout-*`, `oom-*`). Copy it to
  `regressions/<short-name>.bin`; `server/import/docx/fuzz-regressions.test.ts` then replays it in
  `pnpm test`. Fix `readDocx`, not the test.
- Inputs are invented or from the licensed ISTR-6 set; never commit a real student file.
