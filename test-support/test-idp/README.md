# test-support/test-idp

OIDC pružatelj koji živi u jednoj `fetch` funkciji: bez porta i bez mreže. Samo za testove (`server/external/srce-auth`, `server/session`); nijedan proizvodni kod ga ne uvozi (D-09). Svi računi i vrijednosti su izmišljeni.

Prenesen iz Ductusa `tests/unit/auth/test-idp.ts` (`d52a92c3`, S-0.18, DAN-731) bez promjene logike; javno sučelje je `index.ts`.
