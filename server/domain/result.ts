// The one shape of an expected failure (docs/CODE_STYLE.md §8). `code` is a
// stable machine code in UPPER_SNAKE; `messageKey` names the Croatian text in
// locales/. Types only: no I/O and no message text here.
export type AppError = { code: string; messageKey: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
