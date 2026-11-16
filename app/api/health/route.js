import { configStatus } from '../../../lib/auth';
import { storeStatus, probe } from '../../../lib/store';

// Must be evaluated per request: it reports which secrets the running
// deployment actually has, not what the build machine had.
export const dynamic = 'force-dynamic';

export async function GET(req) {
  const url = new URL(req.url || 'http://localhost/api/health');
  const out = {
    ok: true,
    app: 'ventuno-vision',
    // Bump this when the deployed code changes; it proves which build is live.
    rev: 'live-camera-1',
    time: new Date().toISOString(),
    configured: configStatus(),
    store: storeStatus(),
  };
  // ?deep=1 proves the store really works (one read) and returns the exact
  // error when Firestore is misconfigured, instead of an empty 500.
  if (url.searchParams.get('deep') === '1') {
    let probeResult = null;
    let probeOk = true;
    let probeError = null;
    try {
      probeResult = await probe();
    } catch (err) {
      probeOk = false;
      probeError = String((err && err.message) || err);
    }
    // Re-read the status AFTER the probe so a failure that just happened
    // (bad service account, missing database) is reported here.
    out.store = {
      ...storeStatus(),
      ok: probeOk,
      probe: probeResult,
      ...(probeError ? { error: probeError } : {}),
    };
  }
  return Response.json(out, { headers: { 'Cache-Control': 'no-store' } });
}
