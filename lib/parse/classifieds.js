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
 * @param {string} html the `/classified` page body
 * @param {{ now: Date | string }} options `now` — the reference instant for
 *   relative timestamps (the corpus freezes it at `FIXTURE_NOW`)
 * @returns {{ uid: number, listings: object[] }} `uid` from the embedded
 *   `OzB_vars` object (0 = anonymous, non-zero = authenticated); `listings`
 *   in page order
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

  // Structural checks, in order of cheapness. Each one names the class of the
  // bad body in its reason so the poll can log *why* it was unparseable.
  // A body that fails any of them is not a page at all — it says nothing
  // about the session's uid, so it must never be read as uid 0 (expired).
  if (page.trim() === '') {
    throw new ClassifiedsPageError('empty or whitespace-only body');
  }
  // OzB_vars is the site's own embedded session object; a 200 that lacks it
  // is not a classifieds page (a JSON error, a redirect shell, a WAF page…).
  if (!/OzB_vars\s*=/.test(page)) {
    throw new ClassifiedsPageError('missing OzB_vars');
  }
  // A page truncated mid-stream has no closing </html>; cheerio would happily
  // parse a partial document, so the terminator is checked explicitly.
  if (!/\/html\s*>/i.test(page)) {
    throw new ClassifiedsPageError('missing closing </html> terminator');
  }

  const uid = extractUid(page);

  const $ = cheerio.load(page);
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

function extractUid(page) {
  // OzB_vars={...} is embedded in a <script> tag as a plain JS object
  // literal. Read the raw script text and pull out the "uid" field.
  const varsMatch = /OzB_vars\s*=\s*({[^;]*})/.exec(page);
  if (!varsMatch) return 0;
  const uidMatch = /"uid"\s*:\s*(\d+)/.exec(varsMatch[1]);
  return uidMatch ? Number.parseInt(uidMatch[1], 10) : 0;
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
