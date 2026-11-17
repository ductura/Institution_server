# server/domain/settings

Katalog postavki po razinama (S-1J-f, DAN-806; D-298, ugovor Ductus#1836 c.6906291102). Nije iz Ductusa: Ductus postavke po razinama nema.

- `SETTINGS_CATALOGUE`: zatvoren popis ključeva; za svaki razine na kojima smije postojati redak `settings.value`, vrsta (`boolean`, `integer`, `enum`), zadana vrijednost i tvrde granice.
- `settingOf`, `defaultOf`: unos i zadana vrijednost ključa; ključ izvan kataloga daje `undefined`, nikad svojstvo prototipa.
- `checkSettingWrite`: smije li pisanje uopće stići do baze (ključ, razina, vrsta i granice vrijednosti, oblik granice). Tko piše i granice viših razina i dalje odlučuje baza (`settings.set_value`, DAN-801).

Ključ s razinom `network_security` počinje s `network.`, kao u bazi. Postavke backupa (`backup.enabled`, `backup.interval_hours`, `backup.copies`; DAN-1012-1) su samo na razini `system` (D-298); zadano je backup isključen. Odredište i šifriranje nisu postavke (BACKEND §4.7). Novi ključ mijenja vektor rute `settings.catalogue.get`, koji mora biti jednak katalogu (`tests/contracts/settings-catalogue.test.ts`). Izdanje to vidi kao patch lažnog servera (`@ductura/test-fakes`, `scripts/release/level.ts`), a `@ductura/contracts` se ne mijenja.

Ne uvozi ništa izvan `server/domain`.
