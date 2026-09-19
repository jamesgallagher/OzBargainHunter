/**
 * Parse the classifieds listing page (design 3.6).
 *
 * The record shape is pinned by `fixtures/records/classifieds.json`; the
 * derivation rules are in `fixtures/README.md` section 5. This parser mirrors
 * `fixtures/tools/derive_records.py` (`listing_records`) exactly: the page is
 * split into per-listing blocks and each field is read with the same regular
 * expressions, so the output is byte-for-byte the fixture records.
 *
 * @param {string} html the `/classified` page body
 * @param {{ now: Date | string }} options `now` — the reference instant for
 *   relative timestamps (the corpus freezes it at `FIXTURE_NOW`)
 * @returns {{ uid: number, listings: object[] }} `uid` from the embedded
 *   `OzB_vars` object (0 = anonymous, non-zero = authenticated); `listings`
 *   in page order
 */
import { melbourneToUtc, resolveRelativeAge } from '../time.js';

const LISTING_SPLIT = /(?=<div class="node node-classified node-teaser")/;
const RE_NODE_ID = /<h2 class="title" id="title(\d+)"/;
const RE_DATA_TITLE = /<h2 class="title"[^>]*\sdata-title="([^"]*)"/;
const RE_TYPE = /<div class="classified-type-tag ([a-z]+)"/;
const RE_USER = /<a href="\/user\/(\d+)"[^>]*>([^<]*)<\/a>/;
const RE_ABS_TS = /\son (\d{2})\/(\d{2})\/(\d{4}) - (\d{2}):(\d{2})/;
const RE_REL_TS = /<\/strong>\s*((?:\d+\s+\w+\s+)+)ago/;
const RE_PRICE = /<span class="price">\s*([^<]*?)\s*(?:<em>|<\/span>)/s;
const RE_SHIPPING = /<span title="shipping">\s*([^<]*?)\s*<\/span>/;
const RE_THUMB = /<div class="right">.*?<img src="([^"]+)"/s;
const RE_LEADING_TAGS = /^\s*(?:\[([^\]]*)\]\s*)+/;

export function parseClassifiedsPage(html, options = {}) {
  const page = String(html ?? '');
  const now = typeof options.now === 'string' ? new Date(options.now) : options.now;

  const uid = extractUid(page);

  const blocks = page.split(LISTING_SPLIT).slice(1);
  const listings = [];
  for (const block of blocks) {
    const nodeIdMatch = RE_NODE_ID.exec(block);
    if (!nodeIdMatch) throw new Error('classifieds: block without a numeric node id');
    const nodeId = Number.parseInt(nodeIdMatch[1], 10);

    const dataTitleMatch = RE_DATA_TITLE.exec(block);
    const title = dataTitleMatch ? decodeEntities(dataTitleMatch[1]) : '';

    const leading = RE_LEADING_TAGS.exec(title);
    // Collect all leading [tag] segments in order (mirrors RE_ONE_TAG.findall).
    const categoryTags = [];
    if (leading) {
      for (const m of leading[0].match(/\[([^\]]*)\]/g) ?? []) {
        categoryTags.push(decodeEntities(m.slice(1, -1)));
      }
    }

    const user = RE_USER.exec(block);
    let poster = user ? user[2] : null;
    let posterId = user ? Number.parseInt(user[1], 10) : null;
    // OzBargain renders a live /user/ link whose visible text is the literal
    // string "No user info" when the poster is not shown. That is an absent
    // poster, not a user named "No user info".
    if (poster === 'No user info') {
      poster = null;
      posterId = null;
    }

    const absolute = RE_ABS_TS.exec(block);
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
      const relative = RE_REL_TS.exec(block);
      if (!relative) throw new Error(`classifieds: no recognised timestamp in block ${nodeId}`);
      postedAt = resolveRelativeAge(relative[1], now);
      precision = 'relative';
    }

    const price = RE_PRICE.exec(block);
    const shipping = RE_SHIPPING.exec(block);
    const thumb = RE_THUMB.exec(block);

    listings.push({
      node_id: nodeId,
      title,
      url: `https://www.ozbargain.com.au/node/${nodeId}`,
      type: RE_TYPE.exec(block)?.[1] ?? null,
      pinned: block.includes('classified-sticky'),
      category_tags: categoryTags,
      poster,
      poster_id: posterId,
      posted_at: postedAt,
      posted_at_source: precision,
      price: price && price[1] ? decodeEntities(price[1]) : null,
      shipping: shipping ? decodeEntities(shipping[1]) : null,
      thumbnail_url: thumb ? thumb[1] : null,
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
