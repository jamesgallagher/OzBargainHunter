/**
 * The Unraid template guard. The container template `unraid/my-ozbargain-hunter.xml`
 * is the single source of truth for the GUI-managed deployment on the host.
 * This file is the permanent static guard for its shape: a Node built-in
 * `node:test` file that performs static analysis of the XML text only — it
 * never imports or executes an application module, it is offline/deterministic,
 * and it writes no repo files (except throwaway temp fixtures for the icon
 * updater, which are created and removed by this test).
 *
 * The contract (fixed by the card):
 *   - The canonical template lives at `unraid/my-ozbargain-hunter.xml` and the
 *     old `unraid/my-OzBargainHunter.xml` no longer exists.
 *   - The repository template is byte-identical to the reviewed artifact: its
 *     SHA-256 is pinned below.
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
 *   - Every `Mask="true"` Config element is EMPTY in the repository template:
 *     credentials are a later Sponsor GUI step, so the template must never
 *     carry a value in a masked field. The failure message reports only the
 *     field name and count, never the content.
 *
 * Two trust boundaries (D1): the repository template is pinned to exact bytes
 * and empty masked fields; the *deployed* template is a configured dockerMan
 * host template (re-serialized, Sponsor-set values) and is checked only
 * semantically by the shell verifier. This guard therefore proves the
 * repository boundary, and proves the verifier enforces the *semantic* host
 * boundary while containing **no** host-hash or deployed-masked-field gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const unraidDir = fileURLToPath(new URL('../../unraid/', import.meta.url));
const templatePath = `${unraidDir}my-ozbargain-hunter.xml`;
const legacyPath = `${unraidDir}my-OzBargainHunter.xml`;
const verifierPath = `${unraidDir}verify-ozbargain-hunter.sh`;
const updaterPath = `${unraidDir}update-ozbargain-hunter-icon.sh`;

/** The reviewed repository artifact digest (D2). */
const EXPECTED_TEMPLATE_SHA256 = '5cf4bc5e88c68f945210b1129a945bddbbe4d86525b064ba3929df3fb602da52';

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
const updater = existsSync(updaterPath) ? readFileSync(updaterPath, 'utf8') : '';

test('the repository template is byte-identical to the reviewed artifact (pinned SHA-256)', () => {
  assert.ok(xml.length > 0, 'the template must be readable');
  const digest = createHash('sha256').update(xml).digest('hex');
  assert.equal(digest, EXPECTED_TEMPLATE_SHA256, 'the repository template must be the exact reviewed artifact');
});

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

test('every Mask=true Config element is empty in the repository template (message never echoes content)', () => {
  const masked = configElements(xml).filter((c) => c.attrs.Mask === 'true');
  // The template ships with its masked fields intentionally empty: health check
  // secret, CSRF secret, the account cookie, SMTP password, the matrix token
  // and the ntfy token.
  assert.ok(masked.length >= 6, `expected at least 6 masked Config elements, got ${masked.length}`);
  const nonEmpty = masked.filter((c) => c.content !== '');
  // The failure message reports only the field name and the count — never the
  // (empty) content — so a regression can never leak a value.
  assert.equal(
    nonEmpty.length,
    0,
    `${nonEmpty.length} masked Config element(s) are non-empty (names: ${nonEmpty.map((c) => c.attrs.Name).join(', ')})`,
  );
});

test('the verifier enforces the semantic host runtime and application contract', () => {
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
  assert.match(verifier, /unraid-autostart/);
});

test('the verifier makes health=healthy a required post-credential invariant (bounded 360s wait)', () => {
  // Reads only the health status, waits at most 360s in fixed short intervals,
  // and fails unless it reaches exactly "healthy".
  assert.match(verifier, /\.State\.Health\.Status/);
  assert.match(verifier, /HEALTH_WAIT_SECONDS=360/);
  assert.match(verifier, /HEALTH_INTERVAL_SECONDS=\d+/);
  assert.match(verifier, /ok "container health=healthy"/);
  assert.match(verifier, /bad "container health=healthy/);
  // There is no permanent pre-credential exception: the verifier states it.
  assert.match(verifier, /no permanent\s+pre-credential exception/i, 'the verifier must state there is no permanent pre-credential exception');
});

test('the verifier has no host hash and no deployed masked-field gate (D3)', () => {
  // No host/repository hash comparison of the deployed template.
  assert.ok(!/EXPECTED_TEMPLATE_SHA256/.test(verifier), 'the verifier must not pin the repository template hash');
  assert.ok(!/ACTUAL_TEMPLATE_SHA256/.test(verifier), 'the verifier must not compute a deployed template hash');
  assert.ok(!/byte-identical/.test(verifier), 'the verifier must not assert byte identity with the repository template');
  assert.ok(!/sha256sum/.test(verifier), 'the verifier must not hash the deployed template');
  // No scan, count, or assertion concerning Mask="true" elements.
  assert.ok(!/Mask="true"/.test(verifier), 'the verifier must not select, count, or assert Mask="true" fields');
  assert.ok(!/no value in any Mask/.test(verifier), 'the verifier must not assert masked fields are empty');
});

test('the icon updater source is bounded (no docker, no masked-field target, no generic Mask processing) (D5)', () => {
  assert.ok(updater.length > 0, 'the icon updater must exist');
  // No docker/dockerMan/rebuild/restart COMMAND. The default target path
  // legitimately contains "dockerMan" as a directory name; a command
  // invocation is the word followed by whitespace, which the path never is.
  assert.ok(!/\bdocker\s/.test(updater), 'the updater must not invoke docker');
  assert.ok(!/\bdockerMan\s/.test(updater), 'the updater must not invoke dockerMan');
  assert.ok(!/\brebuild\b/.test(updater), 'the updater must not rebuild');
  assert.ok(!/\brestart\b/.test(updater), 'the updater must not restart the container');
  // No deployed masked-field target names.
  for (const name of ['OZB_HEALTHCHECK_SECRET', 'OZB_CSRF_SECRET', 'EMAIL_SMTP_PASS', 'MATRIX_ACCESS_TOKEN', 'NTfy_TOKEN', 'OZB_ACCOUNT_COOKIE']) {
    assert.ok(!updater.includes(name), `the updater must not target masked field ${name}`);
  }
  // No generic Mask="true" processing.
  assert.ok(!/Mask="true"/.test(updater), 'the updater must not process Mask="true" fields');
  // The two exact URL constants are present.
  assert.ok(updater.includes('https://ozb-icon-hosting.invalid/ozbargainhunter-icon-256.png'), 'the old icon URL constant is present');
  assert.ok(updater.includes('https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-256.png'), 'the new icon URL constant is present');
});

/**
 * Run the icon updater against a temp fixture (D5). The fixture is a
 * non-secret template containing only an Icon and unrelated opaque text.
 * Returns { code, stdout, stderr }.
 */
function runUpdater(fixPath) {
  try {
    const stdout = execFileSync('/bin/sh', [updaterPath], {
      env: { ...process.env, OZB_UNRAID_TEMPLATE_PATH: fixPath },
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ? e.stdout.toString() : '', stderr: e.stderr ? e.stderr.toString() : '' };
  }
}

test('the icon updater: old->new changes exactly the intended Icon bytes and preserves surrounding bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-icon-updater-'));
  try {
    const fix = join(dir, 'my-ozbargain-hunter.xml');
    const before =
      '<?xml version="1.0"?>\n<Container version="2">\n  <Name>ozbargain-hunter</Name>\n' +
      '  <Icon>https://ozb-icon-hosting.invalid/ozbargainhunter-icon-256.png</Icon>\n' +
      '  <Repository>ghcr.io/jamesgallagher/ozbargainhunter:latest</Repository>\n</Container>\n';
    writeFileSync(fix, before);
    const res = runUpdater(fix);
    assert.equal(res.code, 0, `updater must succeed (stdout: ${res.stdout} stderr: ${res.stderr})`);
    const after = readFileSync(fix, 'utf8');
    // Only the complete Icon element changed; all surrounding bytes preserved.
    assert.ok(after.includes('<Icon>https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-256.png</Icon>'), 'the new Icon element is present');
    assert.ok(!after.includes('ozb-icon-hosting.invalid'), 'the old Icon element is gone');
    assert.ok(after.includes('<Name>ozbargain-hunter</Name>'), 'surrounding Name preserved');
    assert.ok(after.includes('<Repository>ghcr.io/jamesgallagher/ozbargainhunter:latest</Repository>'), 'surrounding Repository preserved');
    assert.ok(after.startsWith('<?xml version="1.0"?>\n<Container version="2">\n  <Name>'), 'leading bytes preserved');
    assert.ok(after.endsWith('</Container>\n'), 'trailing bytes preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the icon updater: a second run is a no-op and succeeds (idempotent)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-icon-updater-'));
  try {
    const fix = join(dir, 'my-ozbargain-hunter.xml');
    writeFileSync(
      fix,
      '<?xml version="1.0"?>\n<Container version="2">\n  <Icon>https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-256.png</Icon>\n</Container>\n',
    );
    const res = runUpdater(fix);
    assert.equal(res.code, 0, `idempotent run must succeed (stdout: ${res.stdout} stderr: ${res.stderr})`);
    assert.match(res.stdout, /already canonical/i, 'the second run reports the no-op');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the icon updater: ambiguous/missing Icon states fail without changing the fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-icon-updater-'));
  try {
    // Missing Icon entirely.
    const missing = join(dir, 'missing.xml');
    const missingBefore = '<?xml version="1.0"?>\n<Container version="2">\n  <Name>ozbargain-hunter</Name>\n</Container>\n';
    writeFileSync(missing, missingBefore);
    const resMissing = runUpdater(missing);
    assert.notEqual(resMissing.code, 0, 'missing Icon must fail');
    assert.equal(readFileSync(missing, 'utf8'), missingBefore, 'missing-Icon fixture must be unchanged');

    // Both old and new present (ambiguous).
    const both = join(dir, 'both.xml');
    const bothBefore =
      '<?xml version="1.0"?>\n<Container version="2">\n' +
      '  <Icon>https://ozb-icon-hosting.invalid/ozbargainhunter-icon-256.png</Icon>\n' +
      '  <Icon>https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-256.png</Icon>\n' +
      '</Container>\n';
    writeFileSync(both, bothBefore);
    const resBoth = runUpdater(both);
    assert.notEqual(resBoth.code, 0, 'both old and new present must fail');
    assert.equal(readFileSync(both, 'utf8'), bothBefore, 'both-present fixture must be unchanged');

    // Duplicate old elements (ambiguous).
    const dup = join(dir, 'dup.xml');
    const dupBefore =
      '<?xml version="1.0"?>\n<Container version="2">\n' +
      '  <Icon>https://ozb-icon-hosting.invalid/ozbargainhunter-icon-256.png</Icon>\n' +
      '  <Icon>https://ozb-icon-hosting.invalid/ozbargainhunter-icon-256.png</Icon>\n' +
      '</Container>\n';
    writeFileSync(dup, dupBefore);
    const resDup = runUpdater(dup);
    assert.notEqual(resDup.code, 0, 'duplicate old elements must fail');
    assert.equal(readFileSync(dup, 'utf8'), dupBefore, 'duplicate-old fixture must be unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
