// Login and permission helpers.

/** A document as the access rules see it. */
export interface AccessDoc {
  ownerId: string;
  sharedWith?: string[];
}

/**
 * Reads the user identity from the Authorization header.
 * In development the token is the user ID itself ("Bearer student-a@primjer.invalid").
 * It is later replaced by a session check after AAI@EduHr (SAML) login.
 */
export function parseBearer(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/** May the user read the document: the owner or an explicitly added collaborator. */
export function canRead(userId: string | null, doc: AccessDoc | null): boolean {
  if (!userId || !doc) return false;
  if (doc.ownerId === userId) return true;
  return Array.isArray(doc.sharedWith) && doc.sharedWith.includes(userId);
}

/** May the user change the document: the owner only. */
export function canWrite(userId: string | null, doc: AccessDoc | null): boolean {
  return Boolean(userId && doc && doc.ownerId === userId);
}
