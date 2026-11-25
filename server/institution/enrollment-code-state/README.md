# server/institution/enrollment-code-state

Čitač stanja upisne šifre kolegija (`institution.enrollment-code-state.get`).
U jednoj naredbi pod RLS-om provjerava nastavnički odnos prema kolegiju i čita
rok aktivne šifre. Sama šifra se nikad ne čita (A-8): `ductus_app` nema pravo
čitanja stupca `code_hash`. Integracijski test pristupa koristi PostgreSQL u CI-ju.
