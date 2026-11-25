# Predložak rada na zadatku (SRV-V17-TEMPLATE-ASSIGN)

`createAssignmentTemplate` je port nad `app.set_assignment_template` i `app.read_assignment_template`: nastavnik zadatka uključuje ili isključuje predložak ustanove (uključivanje zamrzava zadnju verziju za vrstu rada zadatka), student kolegija čita zamrznuti kostur. Odbijanja su ishodi, ne iznimke: ZD401 `unauthorized`, ZD403 `not_found` (jedan odgovor za svako odbijanje, C-23), ZD409 `conflict` (ustanova još nema predložak za tu vrstu rada), ZD422 `invalid_input`.
