// POST /api/me: what the signed-in user may do (admin tools; plan: free | pro | admin;
// bible: may use the Bible section).
import { send, currentUser, isAdmin, planOf, bibleAccess } from './_lib.js';

export default async function handler(req, res) {
  const user = await currentUser(req).catch(() => null);
  if (!user) return send(res, 401, { error: 'Please sign in again.' });
  return send(res, 200, { admin: isAdmin(user), plan: await planOf(user).catch(() => 'free'), bible: bibleAccess(user) });
}
