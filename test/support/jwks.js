/**
 * A loopback JWKS server and JWT signer for the middleware tests. The
 * application verifies the Access JWT against a remote JWKS (design 8.2); the
 * tests point `CF_JWKS_URL` at a local HTTP server that serves a locally
 * generated RSA key, so no real Cloudflare endpoint is contacted (and the
 * no-network guard allows loopback).
 */

import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, importPKCS8, importSPKI, SignJWT } from 'jose';

/**
 * Start a loopback JWKS server serving a fresh RSA key.
 * @param {object} [opts]
 * @param {string} [opts.kid] the key id
 * @returns {Promise<{ url: string, close: () => Promise<void>, sign: (claims: object, opts?: object) => Promise<string> }>}
 */
export async function startJwksServer({ kid = 'test-key' } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // The public JWK entry served in the JWKS document.
  const publicJwk = await exportJWK(await importSPKI(publicKey, 'RS256'));
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  // The private key for signing test tokens.
  const signingKey = await importPKCS8(privateKey, 'RS256');

  const server = http.createServer((req, res) => {
    if (req.url === '/cdn-cgi/access/certs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/cdn-cgi/access/certs`;

  async function sign(claims, { aud, iss, exp } = {}) {
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid });
    if (aud) jwt = jwt.setAudience(aud);
    if (iss) jwt = jwt.setIssuer(iss);
    if (exp) jwt = jwt.setExpirationTime(exp);
    return jwt.sign(signingKey);
  }

  return {
    url,
    sign,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
