/**
 * Parse the classifieds listing page (design 3.6).
 *
 * The record shape is pinned by `fixtures/records/classifieds.json`; the
 * derivation rules are in `fixtures/README.md` section 5. Each field is
 * scoped to its own listing element (a `div.node.node-classified.node-teaser`),
 * so a field that is absent from a listing is never filled from page
 * furniture (the footer, the next listing, the page chrome). This is what
 * makes the parser robust: the last listing's block no longer runs to
 * `</html>`, and `pinned` is read from the listing's own element rather than
 * a raw substring scan of the whole page.
 *
 * A 200 body that is not a page throws `ClassifiedsPageError`: the body is
 * validated for structural page shape and for an explicitly parsed numeric
 * uid *before* any field is read. A body that merely quotes the tokens this
 * parser looks for (a JSON error envelope, a WAF page echoing the request), a
 * body truncated mid-stream, and a page whose `OzB_vars` carries no readable
 * uid are all unparseable — they say nothing about the session, and must
 * never be read as uid 0 (0 means anonymous, i.e. an expired session).
 *
 * @param {string} html the `/classified` page body
 * @param {{ now: Date | string }} options `now` — the reference instant for
 *   relative timestamps (the corpus freezes it at `FIXTURE_NOW`)
 * @returns {{ uid: number, listings: object[] }} `uid` from the embedded
 *   `OzB_vars` object (0 = anonymous, non-zero = authenticated); `listings`
 *   in page order
 * @throws {ClassifiedsPageError} when the body is not a parseable page
 */
import * as cheerio from 'cheerio';
import { melbourneToUtc, resolveRelativeAge } from '../time.js';

/**
 * A 200 body that is not a parseable classifieds page (empty, truncated,
 * non-HTML, or a listing block that cannot be read). Carries a `code` of
 * `'unparseable'` and a human-readable `reason` that names the class. The
 * caller (the classifieds poll) must resolve this as `unknown`, never as a
 * session expiry: a bad body says nothing about the session.
 */
export class ClassifiedsPageError extends Error {
  /**
   * @param {string} reason the unparseable class, e.g. "empty or whitespace-only"
   */
  constructor(reason) {
    super(`classifieds: ${reason}`);
    this.name = 'ClassifiedsPageError';
    this.code = 'unparseable';
    this.reason = reason;
  }
}

export function parseClassifiedsPage(html, options = {}) {
  const page = String(html ?? '');
  const now = typeof options.now === 'string' ? new Date(options.now) : options.now;

  // Structural validation, in order of cheapness. The body must *be* a page:
  // an HTTP 200 whose body is empty, truncated, or a non-HTML payload says
  // nothing about the session, so it must never be read as uid 0 (which means
  // anonymous, i.e. an expired session). Each check names the class of the bad
  // body in its reason, so the poll can log *why* it was unparseable.
  if (page.trim() === '') {
    throw new ClassifiedsPageError('empty or whitespace-only body');
  }

  const $ = cheerio.load(page);
  // The session object is the site's own `OzB_vars` assignment embedded in a
  // <script> element. Requiring it to live *inside a script element* is what
  // separates a page from a payload that merely quotes the tokens we look for:
  // a JSON error envelope or a WAF page that mentions "OzB_vars = …" in text
  // is not a page, however many of our tokens it contains.
  const scriptSource = $('script')
    .toArray()
    .map((el) => $(el).html() ?? '')
    .join('\n');
  if (!/OzB_vars\s*=\s*{/.test(scriptSource)) {
    throw new ClassifiedsPageError('missing OzB_vars');
  }
  // A page truncated mid-stream has no closing </html>; cheerio would happily
  // parse a partial document, so the terminator is checked explicitly.
  if (!/<\/html\s*>/i.test(page)) {
    throw new ClassifiedsPageError('missing closing </html> terminator');
  }
  // The document element: a body that closes with </html> but never opened an
  // <html> element is a fragment (or a payload quoting the terminator), not a
  // document.
  if (!/<html[\s>]/i.test(page)) {
    throw new ClassifiedsPageError('missing <html> document element');
  }

  const uid = extractUid(scriptSource);

  const listings = [];
  for (const el of $('div.node.node-classified.node-teaser').get()) {
    const $block = $(el);

    // The node id is the numeric suffix of the title heading's id
    // (id="title975570"). Scoped to this listing's own heading. A heading
    // whose id does not end in digits is a listing block the parser cannot
    // read — a truncated or mangled page, not a session signal.
    const $titleHeading = $block.find('h2.title').first();
    const titleId = $titleHeading.attr('id') ?? '';
    const nodeIdMatch = /(\d+)$/.exec(titleId);
    if (!nodeIdMatch) throw new ClassifiedsPageError('listing block with an unreadable node id');
    const nodeId = Number.parseInt(nodeIdMatch[1], 10);

    const title = $titleHeading.attr('data-title') ?? '';

    // Leading [tag] segments, in order.
    const categoryTags = [];
    const leading = /^\s*(?:\[([^\]]*)\]\s*)+/.exec(title);
    if (leading) {
      for (const m of leading[0].match(/\[([^\]]*)\]/g) ?? []) {
        categoryTags.push(decodeEntities(m.slice(1, -1)));
      }
    }

    // The poster is the /user/<id> link's visible text, scoped to this
    // listing. OzBargain renders a live /user/ link whose visible text is
    // the literal string "No user info" when the poster is not shown — an
    // absent poster, not a user named "No user info".
    const $user = $block.find('a[href^="/user/"]').first();
    let poster = $user.length ? decodeEntities($user.text()) : null;
    let posterId = null;
    if ($user.length) {
      const href = $user.attr('href') ?? '';
      const idMatch = /\/user\/(\d+)/.exec(href);
      posterId = idMatch ? Number.parseInt(idMatch[1], 10) : null;
      if (poster === 'No user info') {
        poster = null;
        posterId = null;
      }
    }

    // The timestamp: an absolute stamp ("on 18/09/2026 - 18:23") or a
    // relative age ("1 hour 41 min ago"). Scoped to this listing.
    const blockText = $block.text();
    const absolute = /\s(\d{2})\/(\d{2})\/(\d{4}) - (\d{2}):(\d{2})/.exec(blockText);
    let postedAt;
    let precision;
    if (absolute) {
      postedAt = melbourneToUtc(
        Number.parseInt(absolute[1], 10),
        Number.parseInt(absolute[2], 10),
        Number.parseInt(absolute[3], 10),
        Number.parseInt(absolute[4], 10),
        Number.parseInt(absolute[5], 10),
      );
      precision = 'absolute';
    } else {
      const relative = /<\/strong>\s*((?:\d+\s+\w+\s+)+)ago/.exec($block.html() ?? '');
      if (!relative) throw new ClassifiedsPageError(`no recognised timestamp in listing ${nodeId}`);
      postedAt = resolveRelativeAge(relative[1], now);
      precision = 'relative';
    }

    // The price is the text of the .price span, scoped to this listing and
    // stopping at the first <em> (the shipping note) or the span's close.
    const $price = $block.find('span.price').first();
    let price = null;
    if ($price.length) {
      const priceHtml = $price.html() ?? '';
      // The price is the text before the first <em> (the shipping note) or
      // the span's close. A price-only span has neither in its inner HTML,
      // so the price runs to the end.
      const priceMatch = /^\s*([^<]*?)\s*(?:<em>|<\/span>|$)/.exec(priceHtml);
      price = priceMatch && priceMatch[1] ? decodeEntities(priceMatch[1]) : null;
    }

    // The shipping note, scoped to this listing, trimmed.
    const $shipping = $block.find('span[title="shipping"]').first();
    const shipping = $shipping.length ? decodeEntities($shipping.text().trim()) : null;

    // The thumbnail is the image inside the listing's own div.right, scoped
    // to this listing — never the page-wide footer flag.
    const $thumb = $block.find('div.right img').first();
    const thumbnailUrl = $thumb.attr('src') ?? null;

    // The type tag, scoped to this listing.
    const typeMatch = /classified-type-tag ([a-z]+)/.exec($block.html() ?? '');
    const type = typeMatch ? typeMatch[1] : null;

    // Pinned: read from the listing's own element, not a raw substring scan
    // of the whole page (which would read page furniture).
    const pinned = $block.html().includes('classified-sticky');

    listings.push({
      node_id: nodeId,
      title,
      url: `https://www.ozbargain.com.au/node/${nodeId}`,
      type,
      pinned,
      category_tags: categoryTags,
      poster,
      poster_id: posterId,
      posted_at: postedAt,
      posted_at_source: precision,
      price,
      shipping,
      thumbnail_url: thumbnailUrl,
    });
  }
  return { uid, listings };
}

/**
 * Read the authoritative session uid out of the page's embedded `OzB_vars`
 * object (design 3.6): `0` is anonymous, any non-zero value is authenticated.
 *
 * The uid must be *explicitly* present as an integer literal. A body whose
 * session object carries no readable uid is unparseable — it is never
 * defaulted to 0. Defaulting would claim a session expiry on no evidence,
 * which is the false alarm this module must never raise. An explicitly
 * parsed 0 keeps its meaning, so the genuine anonymous page still expires.
 *
 * @param {string} scriptSource the text of the page's <script> elements
 * @returns {number} the parsed uid
 * @throws {ClassifiedsPageError} when the uid is absent or not an integer
 */
function extractUid(scriptSource) {
  // OzB_vars={...} is embedded in a <script> tag as a plain JS object
  // literal. Read the raw script text and pull out the "uid" field.
  const varsMatch = /OzB_vars\s*=\s*({[^;]*})/.exec(scriptSource);
  if (!varsMatch) throw new ClassifiedsPageError('no OzB_vars object in the page scripts');
  const vars = varsMatch[1];

  // The field must be its own key — `uid`, not the tail of a longer name such
  // as "suid" — hence the required key boundary before it. A quoted *value*
  // that happens to read "uid: 5" is not a key, and does not match.
  if (!/(?:^|[{,\s])["']?uid["']?\s*:/.test(vars)) {
    throw new ClassifiedsPageError('missing uid field in OzB_vars');
  }
  // The value must be a bare integer followed by a field or object boundary.
  // A quoted ("226301"), null, or otherwise unreadable value is malformed,
  // not a uid: refusing it is the fail-safe direction (unknown, never a
  // fabricated expiry).
  const uidMatch = /(?:^|[{,\s])["']?uid["']?\s*:\s*(\d+)\s*[,}]/.exec(vars);
  if (!uidMatch) {
    throw new ClassifiedsPageError('malformed uid in OzB_vars (not an explicit integer)');
  }
  return Number.parseInt(uidMatch[1], 10);
}

function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}
