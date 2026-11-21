# Izjava studenta za nastavnika

`createTeacherDeclarationReader` poziva `app.teacher_declaration` i vraća izjavu vezanu uz živu predaju studenta ili stanje `none` kad žive predaje nema. Pristup provjerava baza prema odnosu nastavnika sa zadatkom; odbijen pristup i nepostojeći rad izgledaju jednako (`not_found`).
