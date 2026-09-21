import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { rfc822ToUtc } from '../time.js';

/**
 * Parse a deals-feed or front-page-feed XML body into deal records.
 *
 * The record shape is pinned by `fixtures/records/deals-page0.json` and
 * `fixtures/records/front-feed.json`; the derivation rules are in
 * `fixtures/README.md` section 5. Records keep feed order.
 *
 * A body that will not parse throws {@link ParseError} — the caller
 * (the poll cycle) records the class `unparseable`, retains the truncated
 * body in `failures` (design 3.7) and upserts nothing from it.
 */

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

const CATEGORY_KINDS = ['cat', 'tag', 'brand', 'product'];

/**
 * Normalise an ISO-8601 stamp carrying an offset (e.g. the `expiry`
 * attribute, `2026-09-21T22:00:00+10:00`) to UTC, `Z`-suffixed, second
 * precision.
 * @param {string} value
 * @returns {string}
 */
function isoToUtc(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ParseError(`unparseable timestamp "${value}"`);
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function rawText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  // fast-xml-parser wraps element text in { '#text': ... } when the element
  // also carries attributes.
  if (typeof value === 'object' && value['#text'] !== undefined) return String(value['#text']);
  return String(value);
}

/**
 * Decode XML character references and the five predefined entities, in a single
 * pass. This mirrors how the reference derivation (`fixtures/tools/derive_records.py`,
 * via ElementTree) treats *normal* element text: `&#039;` → `'`, `&amp;lt;` →
 * `&lt;` (the `&amp;` is decoded once and the result is not re-scanned).
 *
 * It is deliberately NOT applied to `description_html`: that field is wrapped in
 * CDATA in the feed, so its `&#039;` sequences are literal text and must be
 * preserved verbatim (see `fixtures/records/deals-page0.json`).
 * @param {string} value
 * @returns {string}
 */
function decodeXmlText(value) {
  return rawText(value)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * @param {string} domain a category `@domain`, e.g.
 *   `https://www.ozbargain.com.au/brand/weber`
 * @returns {{ kind: string, slug: string } | null}
 */
function categoryFromDomain(domain) {
  const match = new RegExp(`/(${CATEGORY_KINDS.join('|')})/([^/]+)$`).exec(domain ?? '');
  if (!match) return null;
  return { kind: match[1], slug: match[2] };
}

/**
 * Parse the feed body.
 * @param {string} xml the RSS body
 * @returns {object[]} one record per `<item>`, in feed order
 */
export function parseDealsFeed(xml) {
  const body = String(xml ?? '');

  // Well-formedness gate (design 3.5 / 3.7): a 200 whose body is not
  // well-formed XML is a failure, not a partial feed. Without this check a
  // truncated body (e.g. cut after `</guid>`) would parse into a partial
  // document and be upserted with zeroed counters, which a threshold rule
  // would then read as real data. XMLValidator.validate returns `true` for
  // well-formed XML and an error object otherwise.
  const validation = XMLValidator.validate(body);
  if (validation !== true) {
    const err = validation?.err ?? validation;
    throw new ParseError(`XML is not well-formed: ${err?.msg ?? err}`);
  }

  let doc;
  try {
    doc = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      trimValues: true,
    }).parse(body);
  } catch (err) {
    throw new ParseError(`XML did not parse: ${err?.message ?? err}`);
  }

  const items = asArray(doc?.rss?.channel?.item);
  if (items.length === 0) {
    throw new ParseError('no <item> elements found in feed');
  }

  const records = [];
  for (const item of items) {
    const guid = rawText(item.guid);
    const nodeId = Number.parseInt(guid.split(' ')[0], 10);
    if (Number.isNaN(nodeId)) {
      throw new ParseError(`item with no numeric guid: "${guid}"`);
    }

    const meta = item['ozb:meta'] ?? {};
    const categories = [];
    for (const category of asArray(item.category)) {
      const parsed = categoryFromDomain(category['@_domain']);
      if (!parsed) continue;
      categories.push({ ...parsed, label: decodeXmlText(category) });
    }

    records.push({
      node_id: nodeId,
      title: decodeXmlText(item.title),
      url: decodeXmlText(item.link),
      author: decodeXmlText(item['dc:creator']),
      posted_at: rfc822ToUtc(rawText(item.pubDate)),
      expiry_at: meta['@_expiry'] ? isoToUtc(meta['@_expiry']) : null,
      merchant_url: meta['@_url'] ?? null,
      goto_url: meta['@_link'] ?? null,
      image_url: meta['@_image'] ?? null,
      votes_pos: Number.parseInt(meta['@_votes-pos'] ?? '0', 10),
      votes_neg: Number.parseInt(meta['@_votes-neg'] ?? '0', 10),
      comment_count: Number.parseInt(meta['@_comment-count'] ?? '0', 10),
      click_count: Number.parseInt(meta['@_click-count'] ?? '0', 10),
      categories,
      // CDATA in the feed: `&#039;` is literal text here and must be kept verbatim.
      description_html: rawText(item.description),
    });
  }
  return records;
}
