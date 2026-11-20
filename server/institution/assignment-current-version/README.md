# server/institution/assignment-current-version

Čitač za obrazac nastavnika u WEB-19. U jednoj naredbi čita aktualnu verziju
zadatka pod RLS-om i provjerava nastavnički odnos prema tom zadatku.
HTTP sloj provjerava odgovor prema ugovoru `institution.assignment.get`.
Integracijski test pristupa koristi PostgreSQL u CI-ju.
