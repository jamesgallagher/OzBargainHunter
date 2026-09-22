/**
 * The Unraid template guard. The container template `unraid/my-ozbargain-hunter.xml`
 * is the single source of truth for the GUI-managed deployment on the host.
 * This file is the permanent static guard for its shape: a Node built-in
 * `node:test` file that performs static analysis of the XML text only — it
 * never imports or executes an application module, it is offline/deterministic,
 * and it writes no repo files.
 *
 * The contract (fixed by the card):
 *   - The canonical template lives at `unraid/my-ozbargain-hunter.xml` and the
 *     old `unraid/my-OzBargainHunter.xml` no longer exists.
 *   - `<Name>ozbargain-hunter</Name>`, the private GHCR repository with the
 *     moving `:latest` tag, and the `bridge` network.
 *   - Host port 7171 published to container port 8000 (the Config value is the
 *     host port; the Target is the container port).
 *   - The persistent bind mount: `/mnt/user/appdata/ozbargain-hunter/` at
 *     `/data`.
 *   - `<ExtraParams>` carries `--restart unless-stopped` and `TZ` is set to
 *     `Australia/Sydney` explicitly.
 *   - The measured Cloudflare Access team domain is
 *     `tailormade.cloudflareaccess.com`.
 *   - The icon uses the approved public raw.githubusercontent.com URL.
 *   - Every `Mask="true"` Config element is EMPTY: credentials are a later
 *     Sponsor GUI step, so the template must never carry a value in a masked
 *     field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const unraidDir = fileURLToPath(new URL('../../unraid/', import.meta.url));
const templatePath = `${unraidDir}my-ozbargain-hunter.xml`;
const legacyPath = `${unraidDir}my-OzBargainHunter.xml`;
const verifierPath = `${unraidDir}verify-ozbargain-hunter.sh`;

/**
 * Extract the content of every `<Config ...>content</Config>` element as
 * [attrs, content] pairs. The template is single-line-per-element, so a
 * non-greedy line-anchored match is sufficient and deterministic.
 */
function configElements(xml) {
  const re = /<Config\b([^>]*)>(.*?)<\/Config>/g;
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    out.push({ attrs, content: m[2] });
  }
  return out;
}

function topLevel(xml, tag) {
  // Strip XML comments first: the template's header comment names the
  // elements it encodes, and a comment occurrence must never shadow the
  // real element.
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const m = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

test('the canonical template exists and the legacy filename is gone', () => {
  assert.ok(existsSync(templatePath), `expected ${templatePath} to exist`);
  assert.ok(!existsSync(legacyPath), `legacy ${legacyPath} must be deleted`);
});

const xml = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : '';
const verifier = existsSync(verifierPath) ? readFileSync(verifierPath, 'utf8') : '';

test('the template carries the canonical Name, Repository and bridge network', () => {
  assert.equal(topLevel(xml, 'Name'), 'ozbargain-hunter');
  assert.equal(topLevel(xml, 'Repository'), 'ghcr.io/jamesgallagher/ozbargainhunter:latest');
  assert.equal(topLevel(xml, 'Network'), 'bridge');
});

test('the template publishes host 7171 to container 8000', () => {
  const port = configElements(xml).find((c) => c.attrs.Type === 'Port' && c.attrs.Target === '8000');
  assert.ok(port, 'expected a Port Config with Target 8000');
  assert.equal(port.content, '7171', 'the Port Config value is the host port');
});

test('the template mounts the persistent appdata at /data', () => {
  const path = configElements(xml).find((c) => c.attrs.Type === 'Path' && c.attrs.Target === '/data');
  assert.ok(path, 'expected a Path Config with Target /data');
  assert.equal(path.content, '/mnt/user/appdata/ozbargain-hunter/');
});

test('the template restarts unless-stopped and pins TZ=Australia/Sydney', () => {
  assert.equal(topLevel(xml, 'ExtraParams'), '--restart unless-stopped');
  const tz = configElements(xml).find((c) => c.attrs.Target === 'TZ');
  assert.ok(tz, 'expected a Config with Target TZ');
  assert.equal(tz.content, 'Australia/Sydney');
});

test('the template uses the measured Cloudflare Access team domain', () => {
  const domain = configElements(xml).find((c) => c.attrs.Target === 'CF_ACCESS_TEAM_DOMAIN');
  assert.ok(domain, 'expected a Config with Target CF_ACCESS_TEAM_DOMAIN');
  assert.equal(domain.content, 'tailormade.cloudflareaccess.com');
});

test('the template uses the canonical public icon URL', () => {
  assert.equal(
    topLevel(xml, 'Icon'),
    'https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-256.png',
  );
  assert.ok(!xml.includes('ozb-icon-hosting.invalid'));
});

test('every Mask=true Config element is empty (no secret values in the template)', () => {
  const masked = configElements(xml).filter((c) => c.attrs.Mask === 'true');
  // The template ships with its masked fields intentionally empty: health check
  // secret, CSRF secret, the account cookie, SMTP password, the matrix token
  // and the ntfy token.
  assert.ok(masked.length >= 6, `expected at least 6 masked Config elements, got ${masked.length}`);
  for (const c of masked) {
    assert.equal(c.content, '', `masked Config "${c.attrs.Name}" must be empty, got "${c.content}"`);
  }
});

test('the verifier pins the exact repository template bytes', () => {
  const expected = createHash('sha256').update(xml).digest('hex');
  assert.match(verifier, new RegExp(`^EXPECTED_TEMPLATE_SHA256=${expected}$`, 'm'));
  assert.match(verifier, /ACTUAL_TEMPLATE_SHA256=.*sha256sum/);
  assert.match(verifier, /deployed template is byte-identical to repository template/);
});

test('the verifier enforces the running dockerMan runtime and application contract', () => {
  assert.match(verifier, /net\.unraid\.docker\.managed/);
  assert.match(verifier, /MANAGED.*dockerman|dockerman.*MANAGED/s);
  assert.match(verifier, /HostConfig\.NetworkMode/);
  assert.match(verifier, /NET.*bridge|bridge.*NET/s);
  assert.match(verifier, /ST.*running|running.*ST/s);
  assert.match(verifier, /bad "container is running \(status=/);
  assert.match(verifier, /TCP listener on port 7171/);
  assert.match(verifier, /curl .*http:\/\/127\.0\.0\.1:7171\//);
  assert.match(verifier, /supervisor: started the Next\.js server/);
  assert.match(verifier, /and the worker/);
});

test('no comment block contains a double-hyphen (the plugin XML parser rejects it)', () => {
  // The Unraid plugin loads the template with PHP's DOMDocument, which is
  // stricter than a generic parser: a `--` inside an XML comment is a fatal
  // error ("Comment must not contain '--'") and aborts the whole rebuild.
  // The header comment documents the `--restart unless-stopped` flag, so this
  // guard pins the prose to a hyphen-free spelling.
  const comments = xml.match(/<!--[\s\S]*?-->/g) ?? [];
  for (const comment of comments) {
    const inner = comment.slice(4, -3);
    assert.ok(!inner.includes('--'), `comment contains a double-hyphen: ${JSON.stringify(comment.slice(0, 80))}`);
  }
});
