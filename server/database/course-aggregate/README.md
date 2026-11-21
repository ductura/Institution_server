# Čitanje zbirnog pregleda kolegija

Jedan SQL iskaz preko `withActor` koristi postojeće ovlasti kolegija, radova i predaja. Baza vraća tri brojke i odluku o pristupu. U aktivnom članstvu student se broji jednom, prema najdaljoj etapi na zadacima kolegija. Započeti obuhvaćaju i predane.

Kad nastavnik nema pristup obuhvatu svih radova, aktivnih je studenata manje od pet ili ijedna neprazna etapa ima manje od pet, čitač vraća samo `{ status: "suppressed" }`. Tako ni razlika objavljenih brojeva ne daje malu skupinu.
