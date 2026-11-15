import { COOKIE } from '../../../lib/auth';

export async function POST() {
  return Response.json({ ok: true }, {
    headers: {
      'Set-Cookie': `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
      'Cache-Control': 'no-store',
    },
  });
}
