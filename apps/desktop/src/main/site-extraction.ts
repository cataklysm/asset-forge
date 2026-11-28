import { z } from 'zod';

/** Most values one query answers, and the longest value. */
export const EXTRACT_LIMITS = { maxResults: 20_000, maxLength: 10_000 };

/** The isolated world the XPath runs in; any id but 0 (the page's own world). */
export const ISOLATED_WORLD_ID = 1777;

/**
 * Runs in the page's isolated world. Takes its input as one JSON string, never as code: the expressions are data.
 * Answers `{ invalid: name }` for an expression that does not evaluate to nodes, otherwise `{ results, counts,
 * baseUrl }` (the strings per query, the number of nodes it matched, and the document's base URL). Every DOM read
 * goes through the prototypes, so a named element of the page (`<img name="evaluate">`, a form's `<input
 * name="getAttribute">`) cannot stand in for a method or property; a node that still cannot be read is skipped. An
 * evaluate failure other than a syntax or type error is thrown, so the loader asks again. Kept as plain text so no
 * bundler helper ends up in it.
 */
export const EXTRACT_SCRIPT = `function (input) {
  var data = JSON.parse(input);
  var evaluate = Document.prototype.evaluate;
  var getAttribute = Element.prototype.getAttribute;
  var hasAttribute = Element.prototype.hasAttribute;
  var nodeTypeOf = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType').get;
  var nodeValueOf = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeValue').get;
  var baseOf = Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI').get;
  var lengthOf = Object.getOwnPropertyDescriptor(XPathResult.prototype, 'snapshotLength').get;
  var itemOf = XPathResult.prototype.snapshotItem;
  var results = {};
  var counts = {};
  var names = Object.keys(data.queries);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var found;
    try {
      found = evaluate.call(document, data.queries[name], document, null, 7, null);
    } catch (error) {
      var kind = '';
      try {
        kind = String(error.name);
      } catch (unreadable) {
        kind = '';
      }
      if (kind === 'SyntaxError' || kind === 'TypeError' || kind === 'NamespaceError') return { invalid: name };
      throw error;
    }
    var total = lengthOf.call(found);
    var values = [];
    for (var j = 0; j < total && values.length < data.maxResults; j++) {
      try {
        var node = itemOf.call(found, j);
        var type = nodeTypeOf.call(node);
        var value = null;
        if (type === 1) {
          if (hasAttribute.call(node, 'href')) value = getAttribute.call(node, 'href');
          else if (hasAttribute.call(node, 'src')) value = getAttribute.call(node, 'src');
        } else if (type === 2 || type === 3) {
          value = nodeValueOf.call(node);
        }
        if (typeof value === 'string') values.push(value.slice(0, data.maxLength));
      } catch (skipped) {
        // One node that cannot be read is left out.
      }
    }
    results[name] = values;
    counts[name] = total;
  }
  var baseUrl = '';
  try {
    baseUrl = baseOf.call(document);
  } catch (unreadable) {
    baseUrl = '';
  }
  return { results: results, counts: counts, baseUrl: typeof baseUrl === 'string' ? baseUrl : '' };
}`;

/** The code handed to the isolated world: the script applied to its input, the input a JSON string literal. */
export function extractionCode(queries: Record<string, string>, limits = EXTRACT_LIMITS): string {
  const input = JSON.stringify({ queries, maxResults: limits.maxResults, maxLength: limits.maxLength });
  return `(${EXTRACT_SCRIPT})(${JSON.stringify(input)})`;
}

const ExtractionSchema = z.union([
  z.object({ invalid: z.string() }),
  z.object({
    results: z.record(z.string(), z.array(z.unknown())),
    counts: z.record(z.string(), z.number()),
    baseUrl: z.unknown().optional(),
  }),
]);

export type Extraction =
  | { kind: 'invalid'; query: string }
  | { kind: 'results'; results: Record<string, string[]>; counts: Record<string, number>; baseUrl: string };

/**
 * Reads what the page answered, trusting none of it: only the names asked for, only strings, cut at the limits
 * again. Null for anything else. A base URL that is not a string or longer than the value limit reads as `''`; the
 * crawl decides whether it is usable.
 */
export function readExtraction(raw: unknown, names: readonly string[], limits = EXTRACT_LIMITS): Extraction | null {
  const parsed = ExtractionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  if ('invalid' in data) return names.includes(data.invalid) ? { kind: 'invalid', query: data.invalid } : null;
  const results: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  for (const name of names) {
    const values = Object.hasOwn(data.results, name) ? data.results[name]! : [];
    results[name] = values
      .filter((value): value is string => typeof value === 'string')
      .slice(0, limits.maxResults)
      .map((value) => value.slice(0, limits.maxLength));
    const count = Object.hasOwn(data.counts, name) ? data.counts[name]! : 0;
    counts[name] = Number.isFinite(count) ? count : 0;
  }
  const baseUrl = typeof data.baseUrl === 'string' && data.baseUrl.length <= limits.maxLength ? data.baseUrl : '';
  return { kind: 'results', results, counts, baseUrl };
}
