# HTTP za zbirni pregled kolegija

`GET /api/v1/courses/{id}/aggregate` daje nastavniku kolegija zbirni presjek bez filtara. Ovlast proizlazi iz sesije i članstva u kolegiju. Odgovor nosi `Cache-Control: no-store`.

Testovi prolaze kroz montirani HTTP rukovatelj s dvojnikom adaptera, a PostgreSQL test provjerava izvore mjera i ovlasti postojećih čitača.
