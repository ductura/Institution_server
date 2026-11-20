# HTTP za etape rada

`GET /api/v1/works/{documentId}/milestones` vraća popis etapa vlasniku i ovlaštenom nastavniku. `PATCH /api/v1/works/{documentId}/milestones/{milestoneId}` prima `{dueAt}` i vraća ažuriranu etapu. Vrijeme se u odgovoru prikazuje u UTC-u. Tuđi i nepostojeći rad vraćaju 404. Student za pokušaj izmjene vlastitog rada dobiva 403. Nakon konačne predaje nastavnik dobiva 409.

`createWorkMilestonesRoutesFor` montira oba rukovatelja. Test prolazi kroz HTTP i pozive adaptera uz simuliranu bazu.
