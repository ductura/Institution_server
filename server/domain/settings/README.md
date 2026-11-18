# server/domain/settings

Katalog postavki po razinama (S-1J-f, DAN-806; D-298, ugovor Ductus#1836 c.6906291102). Nije iz Ductusa: Ductus postavke po razinama nema.

- `SETTINGS_CATALOGUE`: zatvoren popis ključeva; za svaki razine na kojima smije postojati redak `settings.value`, vrsta (`boolean`, `integer`, `enum`), zadana vrijednost i tvrde granice.
- `settingOf`, `defaultOf`: unos i zadana vrijednost ključa; ključ izvan kataloga daje `undefined`, nikad svojstvo prototipa.
- `checkSettingWrite`: smije li pisanje uopće stići do baze (ključ, razina, vrsta i granice vrijednosti, oblik granice). Tko piše i granice viših razina i dalje odlučuje baza (`settings.set_value`, DAN-801).

Ključ s razinom `network_security` počinje s `network.`, kao u bazi. Postavke backupa (`backup.enabled`, `backup.interval_hours`, `backup.copies`; DAN-1012-1) su samo na razini `system` (D-298); zadano je backup isključen. Odredište i šifriranje nisu postavke (BACKEND §4.7). Pragovi ustanove P-01 do P-04 (Ductus DECISIONS, „Zadane vrijednosti pragova”; DAN-1060-1) su samo na razini `institution`: `thresholds.session_gap_minutes` (30, 1–240), `thresholds.paste_event_chars` (200, 1–100000; P-05 je isti prag i nema svoj ključ), `thresholds.teacher_refresh_minutes` (5, 1–60) i `thresholds.short_assignment_hours` (24, 1–168). Mijenja ih samo administrator te ustanove (`settings.set_value`), a dokaz je `tests/db/institution-thresholds-route.integration.test.ts`. Tvrde granice nisu vlasnikova odluka; proširenje je jeftino, a sužavanje nije, jer se spremljeni retci ponovno ne provjeravaju. Pravilo AI-ja po vrsti rada nije ovdje: ostaje u `institution.faculty_rule_version` (DAN-315), s verzijama koje se vežu na zadatke (D-174). Novi ključ mijenja vektor rute `settings.catalogue.get`, koji mora biti jednak katalogu (`tests/contracts/settings-catalogue.test.ts`). Izdanje to vidi kao patch lažnog servera (`@ductura/test-fakes`, `scripts/release/level.ts`), a `@ductura/contracts` se ne mijenja.

Ne uvozi ništa izvan `server/domain`.
