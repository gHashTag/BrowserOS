import { describe, expect, it } from 'bun:test'
import { NLTK_STOP_WORDS } from '../../src/tools/acl/acl-stopwords'

/**
 * Pins the contract of the module exactly as it stands today: no behaviour is
 * redesigned here, only observed and held down, so the next change to the
 * vocabulary has something to fail against.
 *
 * NLTK_STOP_WORDS is the sole export of the module and the sole symbol this
 * suite covers, named in the test title below so assertions map to exports.
 * The export is a plain Set of strings, so every property asserted here is
 * reachable through the public surface alone: has(), iteration, and size.
 * Nothing in this module needs a network, a database or a container, so no
 * export is left unexercised by a blocked dependency.
 */

/** Function words that the vocabulary must recognise, grouped by class. */
const WORD_CLASSES: Record<string, string[]> = {
  articles: ['a', 'an', 'the'],
  prepositions: ['of', 'in', 'on', 'at', 'by', 'for', 'to', 'from', 'with', 'into', 'between', 'through', 'under', 'over', 'above', 'below', 'against', 'before', 'after', 'until', 'during'],
  pronouns: ['he', 'she', 'it', 'they', 'them', 'themselves', 'yourself', 'ours', 'my', 'his', 'her', 'their', 'this', 'that', 'these', 'those', 'who', 'whom', 'which', 'what'],
  conjunctions: ['and', 'but', 'or', 'nor', 'so', 'than', 'because', 'while'],
  auxiliaries: ['is', 'was', 'were', 'have', 'has', 'had', 'do', 'does', 'did', 'doing', 'be', 'been', 'being', 'will', 'should'],
  adverbsAndQuantifiers: ['very', 'too', 'just', 'now', 'here', 'there', 'then', 'again', 'further', 'once', 'only', 'own', 'same', 'such', 'each', 'few', 'more', 'most', 'other', 'some', 'any', 'all', 'both', 'out', 'up', 'down', 'off', 'not', 'no'],
  questionWords: ['when', 'where', 'why', 'how'],
}

/**
 * Each contraction appears in the vocabulary twice: once whole with its
 * apostrophe, once as the truncated stem a tokenizer can emit before the
 * apostrophe is stripped. Both spellings are part of the contract.
 */
const CONTRACTIONS: Array<[full: string, stem: string]> = [
  ["aren't", 'aren'],
  ["couldn't", 'couldn'],
  ["didn't", 'didn'],
  ["doesn't", 'doesn'],
  ["don't", 'don'],
  ["hadn't", 'hadn'],
  ["hasn't", 'hasn'],
  ["haven't", 'haven'],
  ["mightn't", 'mightn'],
  ["mustn't", 'mustn'],
  ["needn't", 'needn'],
  ["shan't", 'shan'],
  ["shouldn't", 'shouldn'],
  ["wasn't", 'wasn'],
  ["weren't", 'weren'],
  ["won't", 'won'],
  ["wouldn't", 'wouldn'],
]

/**
 * Words the vocabulary must not swallow. Content words, because the point of
 * a stop-word list is to remove function words and keep content; capitalised
 * spellings, because membership is case-sensitive and the consumer is
 * expected to lowercase before asking; and padded or empty strings, because
 * the list holds bare tokens only.
 */
const NON_MEMBERS = [
  'computer', 'house', 'zebra', 'quickly', 'runner',
  'The', 'And', 'IT', 'You',
  '', ' the ', 'the ', ' th',
]

describe('aclStopwordsContract', () => {
  it('NLTK_STOP_WORDS: a Set of 198 lowercase English function words, with every contraction stem, admitting no content word, capitalised spelling or padded token', () => {
    // The export behaves as a Set so consumers can ask membership, spread and
    // count through the standard interface.
    expect(NLTK_STOP_WORDS instanceof Set, 'export must be a Set').toBe(true)

    // Function words of every class are members.
    for (const [wordClass, words] of Object.entries(WORD_CLASSES)) {
      for (const word of words) {
        expect(NLTK_STOP_WORDS.has(word), `expected ${wordClass} word "${word}" to be a stop word`).toBe(true)
      }
    }

    // Contractions are members in both spellings: whole and truncated stem.
    for (const [full, stem] of CONTRACTIONS) {
      expect(NLTK_STOP_WORDS.has(full), `expected contraction "${full}" to be a stop word`).toBe(true)
      expect(NLTK_STOP_WORDS.has(stem), `expected truncated stem "${stem}" to be a stop word`).toBe(true)
    }

    // The eight single-letter tokens the list keeps are all members; a list
    // that silently dropped one-letter entries would let "i" and "a" through.
    for (const letter of ['a', 'd', 'i', 'm', 'o', 's', 't', 'y']) {
      expect(NLTK_STOP_WORDS.has(letter), `expected single letter "${letter}" to be a stop word`).toBe(true)
    }

    // Content words are not members: the list removes function words only.
    // Capitalised spellings are not members: lookups are case-sensitive, so a
    // consumer must lowercase its token first. Padded and empty strings are
    // not members: the list holds bare tokens.
    for (const word of NON_MEMBERS) {
      expect(NLTK_STOP_WORDS.has(word), `expected "${word}" not to be a stop word`).toBe(false)
    }

    // Every member is a bare lowercase token: non-empty, letters and internal
    // apostrophes only, never padded, never capitalised, never quoted.
    const members = [...NLTK_STOP_WORDS]
    expect(members.length, 'iteration must yield the whole vocabulary').toBe(NLTK_STOP_WORDS.size)
    for (const word of members) {
      expect(/^[a-z']+$/.test(word), `member "${word}" must be lowercase letters with at most internal apostrophes`).toBe(true)
      expect(word.startsWith("'"), `member "${word}" must not begin with an apostrophe`).toBe(false)
      expect(word.endsWith("'"), `member "${word}" must not end with an apostrophe`).toBe(false)
    }

    // The vocabulary counts 198 words as the module stands today; a shorter
    // or longer list means the file changed, and that is worth failing on.
    expect(NLTK_STOP_WORDS.size, 'vocabulary size').toBe(198)
  })
})
