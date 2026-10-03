// POST /api/me: what the signed-in user may do (used to show admin-only tools).
import { send, currentUser, isAdmin } from './_lib.js';

export default async function handler(req, res) {
  const user = await currentUser(req).catch(() => null);
  if (!user) return send(res, 401, { error: 'Please sign in again.' });
  return send(res, 200, { admin: isAdmin(user) });
}
