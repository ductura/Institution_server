# direct-edit

Priključak baze za izravne izmjene nastavnika (SRV-1702, M6.4; D-21, D-34, D-244; migracija `20261129100100_teacher_direct_edit.sql`). Jedan poziv je jedna `withActor` transakcija nad RPC-ovima sheme `collaboration`: postavku mijenja samo student vlasnik, postavku i zapis čitaju student i nastavnici zadatka istim izlazom, a nastavnik objavljuje izmjenu živog stanja samo dok je postavka uključena. Ne čita i ne piše evidenciju.
