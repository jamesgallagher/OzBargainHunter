/**
 * Match rule (design 5.1). A product or company term drawn from a managed
 * list, matched against deals and classifieds.
 *
 * Matching runs over the deal title, description text and structured category
 * labels, and over the classifieds title, category tag and type badge. Items
 * from the front-page feed are matched as well as items from the deals feed
 * (D43).
 *
 * Default mode is "all tokens present, in any order, word-boundary anchored."
 * A keyword rule uses "any token present." Word boundaries are mandatory: a
 * token must be a whole word, so `ple` does not match inside `simple`.
 *
 * If a term is pinned to a confirmed /product/, /brand/ or /tag/ slug,
 * matching against that slug is exact and additive: a record carrying that
 * slug matches even if the term does not appear in the free text.
 */

import { tokenise } from './normalise.js';

/**
 * Strip HTML tags from a description, leaving the text content.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, ' ')
    .replace(/&#39;/g, ' ')
    .replace(/&apos;/g, ' ')
    .replace(/&#\d+;/g, ' ');
}

/**
 * The text a match rule runs over, for a record from a given surface.
 * @param {object} record
 * @param {'deals' | 'front' | 'classifieds'} surface
 * @returns {string}
 */
export function searchableText(record, surface) {
  const parts = [record.title ?? ''];
  if (surface === 'deals' || surface === 'front') {
    if (record.description_html) parts.push(stripHtml(record.description_html));
    if (Array.isArray(record.categories)) {
      for (const c of record.categories) {
        if (c.label) parts.push(c.label);
        if (c.slug) parts.push(c.slug);
      }
    }
  } else {
    if (Array.isArray(record.category_tags)) parts.push(...record.category_tags);
    if (record.type) parts.push(record.type);
  }
  return parts.join(' ');
}

/**
 * On classifieds, only *Selling* listings are eligible for a match rule.
 * Wanted and Swapping never alert, and neither does any pinned listing,
 * whatever it matches. Freebie is its own notification class (6.6), not a
 * match-rule target.
 * @param {object} record a classifieds record
 * @returns {boolean}
 */
export function isClassifiedsEligible(record) {
  return record.type === 'sell' && record.pinned !== true;
}

/**
 * Evaluate a match rule against one record.
 * @param {{ term: string, mode?: 'all' | 'keyword', pinnedSlug?: string | null }} rule
 * @param {object} record a deal or classifieds record
 * @param {'deals' | 'front' | 'classifieds'} surface
 * @returns {{ matched: boolean, matchedTerm: string | null, via: 'term' | 'slug' | null }}
 */
export function matchRule(rule, record, surface) {
  const tokens = Array.from(tokenise(rule.term));
  if (tokens.length === 0) return { matched: false, matchedTerm: null, via: null };

  const textTokens = new Set(tokenise(searchableText(record, surface)));

  let termMatched;
  if (rule.mode === 'keyword') {
    termMatched = tokens.some((t) => textTokens.has(t));
  } else {
    // default 'all': every token present, in any order, word-boundary anchored
    termMatched = tokens.every((t) => textTokens.has(t));
  }

  // Exact, additive slug match.
  let slugMatched = false;
  if (rule.pinnedSlug) {
    const slugs = new Set();
    if (Array.isArray(record.categories)) {
      for (const c of record.categories) if (c.slug) slugs.add(c.slug);
    }
    if (Array.isArray(record.category_tags)) {
      for (const tag of record.category_tags) slugs.add(tag.toLowerCase());
    }
    slugMatched = slugs.has(String(rule.pinnedSlug).toLowerCase());
  }

  const matched = termMatched || slugMatched;
  return {
    matched,
    matchedTerm: matched ? rule.term : null,
    via: termMatched ? 'term' : slugMatched ? 'slug' : null,
  };
}
