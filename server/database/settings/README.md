# Čitanje postavki

`readSettingsValues` čita postavke iz opsega žive sesije. Za razinu ustanove `settings.read_institution_values()` daje pun popis administratoru, a nastavniku i studentu daje samo `citation.style` i `lekta.profile`. `settings.read_values` poslužuje ostale razine. Današnji ključevi pripadaju svaki jednoj razini pa naslijeđene vrijednosti dolaze iz kataloga.
