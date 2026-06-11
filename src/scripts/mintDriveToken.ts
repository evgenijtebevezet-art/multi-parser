import 'dotenv/config';
import { createServer } from 'node:http';
import { google } from 'googleapis';

/**
 * One-shot helper to mint a Google Drive OAuth refresh token for the banker's
 * durable storage. Run locally; paste the printed values into the GitHub Actions
 * secrets GDRIVE_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN.
 *
 * Why: production saw `invalid_client` on every upload — the stored OAuth client
 * id/secret/refresh-token are stale or mismatched. Create a *Desktop app* OAuth
 * client in YOUR GCP project (with the Drive API enabled) and run this to get a
 * matching refresh token. A Desktop client allows the http://localhost redirect
 * used below without pre-registration.
 *
 * Usage:
 *   GDRIVE_OAUTH_CLIENT_ID=... GDRIVE_OAUTH_CLIENT_SECRET=... npx tsx src/scripts/mintDriveToken.ts
 *   # or
 *   npx tsx src/scripts/mintDriveToken.ts <client_id> <client_secret>
 */

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
// drive.file = the app can only see/manage files it creates — minimal scope that
// still covers upload, per-niche folder creation, and reader download-back.
const SCOPE = ['https://www.googleapis.com/auth/drive.file'];

const clientId = process.env.GDRIVE_OAUTH_CLIENT_ID ?? process.argv[2];
const clientSecret = process.env.GDRIVE_OAUTH_CLIENT_SECRET ?? process.argv[3];

if (!clientId || !clientSecret) {
  console.error('Missing client credentials.');
  console.error('Usage: GDRIVE_OAUTH_CLIENT_ID=... GDRIVE_OAUTH_CLIENT_SECRET=... npx tsx src/scripts/mintDriveToken.ts');
  console.error('   or: npx tsx src/scripts/mintDriveToken.ts <client_id> <client_secret>');
  process.exit(1);
}

const oauth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);
const authUrl = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // force a refresh_token even if the app was authorized before
  scope: SCOPE,
});

const server = createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith('/oauth2callback')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const u = new URL(req.url, REDIRECT);
  const err = u.searchParams.get('error');
  if (err) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`OAuth error: ${err}. You can close this tab.`);
    console.error('OAuth error:', err);
    server.close();
    process.exit(1);
  }
  const code = u.searchParams.get('code');
  if (!code) {
    res.writeHead(400);
    res.end('missing ?code');
    return;
  }
  try {
    const { tokens } = await oauth.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Done — refresh token printed in the terminal. You can close this tab.');
    const refresh = tokens.refresh_token;
    console.log('\n=== Paste these into GitHub Actions → Settings → Secrets ===');
    console.log('GDRIVE_OAUTH_CLIENT_ID     =', clientId);
    console.log('GDRIVE_OAUTH_CLIENT_SECRET =', clientSecret);
    console.log('GDRIVE_OAUTH_REFRESH_TOKEN =', refresh ?? '(NONE — revoke the app at https://myaccount.google.com/permissions and re-run)');
    console.log('\ngranted scope:', tokens.scope);
    server.close();
    process.exit(refresh ? 0 : 1);
  } catch (e) {
    res.writeHead(500);
    res.end('token exchange failed — see terminal');
    console.error('Token exchange failed:', e instanceof Error ? e.message : e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('OAuth client must be type "Desktop app" (or a Web client with this redirect authorized):');
  console.log('   ', REDIRECT);
  console.log('\nOpen this URL in your browser and approve with the Google account that owns the target Drive:');
  console.log('\n   ' + authUrl + '\n');
});
