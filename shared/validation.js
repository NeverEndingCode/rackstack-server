// Shared validation rules used by both the client (pre-validation, for
// instant inline feedback) and the server (source of truth, enforced on
// PUT /api/me/username) so the two never drift apart.

/** 3-20 chars, letters/digits/underscore/hyphen only. Case-insensitive
 *  uniqueness is enforced separately, server-side, in server/db.js. */
export const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
