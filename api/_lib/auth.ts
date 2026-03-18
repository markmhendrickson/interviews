import type { VercelRequest } from "@vercel/node";

export function isAdminAuthorized(req: VercelRequest): boolean {
  const passphrase = process.env.ADMIN_PASSPHRASE;
  if (!passphrase) return false;
  const auth = req.headers.authorization;
  return auth === `Bearer ${passphrase}`;
}
