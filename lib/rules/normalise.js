/**
 * Normalisation and tokenisation (design 5.1).
 *
 * Normalise: lower-case, punctuation stripped, whitespace runs collapsed, so
 * that `AMD R9700` and `amd  r9700` behave identically.
 *
 * Tokenisation is word-boundary anchored. A term matches a text only when it
 * is a whole word: `ple` must not match inside `simple`. The match is
 * therefore a test over the token set, not a substring test.
 */

/**
 * @param {string} text
 * @returns {string} the normalised form: lower-cased, non-alphanumeric runs
 * collapsed to a single space, trimmed.
 */
export function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text
 * @returns {Set<string>} the set of distinct normalised tokens.
 */
export function tokenise(text) {
  const normalised = normalise(text);
  if (normalised === '') return new Set();
  return new Set(normalised.split(' '));
}

/**
 * @param {string} text
 * @returns {string[]} the ordered list of tokens (with duplicates preserved, so
 * multi-word substring matching is possible).
 */
export function textTokens(text) {
  const normalised = normalise(text);
  if (normalised === '') return [];
  return normalised.split(' ');
}

/**
 * Whether a term (which may itself be multi-word) is present in a text,
 * word-boundary anchored. A single-token term must equal one of the text's
 * tokens; a multi-word term must appear as a contiguous run of tokens in the
 * text. This is what keeps `ple` from matching inside `simple`.
 * @param {string} term
 * @param {string} text
 * @returns {boolean}
 */
export function containsTerm(term, text) {
  const termTokens = Array.from(tokenise(term));
  if (termTokens.length === 0) return false;
  const orderedTokens = textTokens(text);
  if (termTokens.length === 1) {
    return orderedTokens.includes(termTokens[0]);
  }
  // Multi-word: the term's tokens must appear as a contiguous subsequence.
  for (let i = 0; i + termTokens.length <= orderedTokens.length; i += 1) {
    let match = true;
    for (let j = 0; j < termTokens.length; j += 1) {
      if (orderedTokens[i + j] !== termTokens[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}
