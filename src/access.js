// Pomoćne funkcije za prijavu i ovlasti.

/**
 * Izvlači identitet korisnika iz zaglavlja Authorization.
 * U razvoju je token samo ID korisnika ("Bearer ana@fpzg.hr").
 * Kasnije ga zamjenjuje provjera sesije nakon AAI@EduHr (SAML) prijave.
 * @param {string | undefined} header
 * @returns {string | null}
 */
export function parseBearer(header) {
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Smije li korisnik čitati dokument: vlasnik ili izričito dodani suradnik.
 * @param {string | null} userId
 * @param {{ ownerId: string, sharedWith?: string[] }} doc
 */
export function canRead(userId, doc) {
  if (!userId || !doc) return false;
  if (doc.ownerId === userId) return true;
  return Array.isArray(doc.sharedWith) && doc.sharedWith.includes(userId);
}

/** Smije li korisnik mijenjati dokument: samo vlasnik. */
export function canWrite(userId, doc) {
  return Boolean(userId && doc && doc.ownerId === userId);
}
