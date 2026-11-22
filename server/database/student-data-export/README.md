# Izvoz podataka studenta

`createStudentDataExports` poziva `app.request_student_data_export`, `app.approve_student_data_export`, `app.student_data_exports` i `app.consume_student_data_export` (SRV-1307). Ovlasti provjerava baza; adapter prevodi njezine kodove (`ZD401`, `ZD403`, `ZD404`, `ZD409`, `ZD410`, `ZD422`) u stanja i provjerava oblik redaka. `consume` radi bez sesije i učitava paket u istoj transakciji: ako učitavanje padne, poveznica ostaje neiskorištena.

`createStudentDataExportWorker` je port workera nad njegovom prijavom: odobreni poslovi, sadržaj paketa (`app.worker_student_data_export_submissions`, `_notes`, `_access_log`, SRV-1308), oznaka spremnosti sa SHA-256 tokena i istek.
