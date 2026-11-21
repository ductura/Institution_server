# Kopiranje zadatka

Port poziva `institution.copy_assignment` preko `withActor` (SRV-1904, P-D4). Nastavnik zadatka kopira ga u kolegij koji predaje. Kopija je novi zadatak s verzijom 1 i sadržajem trenutačne verzije izvora; izvor se ne mijenja, a predaje i retci o studentima se ne kopiraju.

Ulaz se provjerava prije baze. Odbijanja su ishodi, ne iznimke: ZD401 `unauthorized`, ZD403 `not_found` (isti odgovor za svako odbijanje, C-23), ZD409 `conflict`, ZD422 `invalid_input`.
