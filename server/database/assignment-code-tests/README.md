# Testovi koda uz zadatak (SRV-V21-KOD-TESTOVI-RUTA)

`createAssignmentCodeTests(withActor)` je port baze za testove koda uz zadatak: do 10 testova `{id, title, input, expected}` za JavaScript. `input` i `expected` su bilo koje JSON vrijednosti.

- Revizije se samo dodaju (`institution.assignment_code_tests`, SRV-V21-KOD-TESTOVI-DB). `publish` poziva `app.set_assignment_code_tests` i vraća novu reviziju; broj revizije određuje baza.
- `read` poziva `app.get_assignment_code_tests` i vraća zadnju reviziju. Dok je nema, vraća reviziju 0, jezik `javascript` i prazan popis.
- Greške baze (`ZD401`, `ZD403`, `ZD404`, `ZD422`) port ne hvata; preslikava ih HTTP rub.

PgTAP: `db/main/tests/254-assignment-code-tests.sql`.
