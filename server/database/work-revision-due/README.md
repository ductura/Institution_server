# server/database/work-revision-due

Luka za čitanje roka dorade rada (F4-NAS-R16-SRV, NAS-R16): jedan RPC `app.read_work_revision_due` (migracija 20261220210000). Vraća rok otvorenog vraćanja na doradu (`evidence.submission_return.revision_due_at`) dok student nije ponovno predao. Čita student vlasnik i nastavnik zadatka; svi ostali dobivaju `not_found`. Ništa se ne piše; komentar vraćanja se ne čita.
