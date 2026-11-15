import { configStatus } from '../../../lib/auth';

// Must be evaluated per request: it reports which secrets the running
// deployment actually has, not what the build machine had.
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    ok: true,
    app: 'ventuno-vision',
    time: new Date().toISOString(),
    configured: configStatus(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
