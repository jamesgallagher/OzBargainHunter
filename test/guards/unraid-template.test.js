/**
 * The Unraid template guard. The container template `unraid/my-ozbargain-hunter.xml`
 * is the single source of truth for the GUI-managed deployment on the host.
 * Static checks of the XML text only: offline, deterministic, no application
 * module imported.
 *
 * Each test pins one deployment property that would silently break the host
 * if it changed: the name, repository and network, the published port, the
 * persistent mount, the restart policy and time zone, the Cloudflare Access
 * team domain, the icon URL, empty masked fields (the template must never
 * carry a credential), and the Unraid plugin's XML comment restriction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const templatePath = fileURLToPath(new URL('../../unraid/my-ozbargain-hunter.xml', import.meta.url));
const xml = readFileSync(templatePath, 'utf8');

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
    'https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-1024.png',
  );
  assert.ok(!xml.includes('ozb-icon-hosting.invalid'));
});

test('every Mask=true Config element is empty in the repository template (message never echoes content)', () => {
  const masked = configElements(xml).filter((c) => c.attrs.Mask === 'true');
  // The template ships with its masked fields intentionally empty: health check
  // secret, CSRF secret, the account cookie, the matrix token and the ntfy
  // token.
  assert.ok(masked.length >= 5, `expected at least 5 masked Config elements, got ${masked.length}`);
  const nonEmpty = masked.filter((c) => c.content !== '');
  // The failure message reports only the field name and the count — never the
  // (empty) content — so a regression can never leak a value.
  assert.equal(
    nonEmpty.length,
    0,
    `${nonEmpty.length} masked Config element(s) are non-empty (names: ${nonEmpty.map((c) => c.attrs.Name).join(', ')})`,
  );
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
