/** The product token the crawl obeys before the `*` group. */
export const ROBOTS_PRODUCT_TOKEN = 'assetforge';

/** One Allow or Disallow line of a group. */
export interface RobotsRule {
  /** True for Allow, false for Disallow. */
  allow: boolean;
  /** The path pattern with percent escapes in upper case; `*` any run, a trailing `$` the end. */
  pattern: string;
}

/** One group of a robots.txt: its user-agent values and its rules. */
export interface RobotsGroup {
  /** Lower-case user-agent values of the group. */
  agents: string[];
  /** The rules in file order. */
  rules: RobotsRule[];
}

/** A parsed robots.txt. */
export interface RobotsRules {
  /** The groups in file order. */
  groups: RobotsGroup[];
}

/** One `key: value` line of a robots.txt, the key in lower case. */
interface RobotsField {
  key: string;
  value: string;
}

/**
 * Percent-encodes what a URL path would encode and upper-cases every escape, so patterns and paths compare alike.
 *
 * @param path the path, or a pattern
 * @returns the normalised path
 */
function normalizePath(path: string): string {
  let encoded: string;
  try {
    encoded = encodeURI(path);
  } catch {
    encoded = path;
  }
  // encodeURI escapes `%` itself; undo that for escapes that were already there.
  encoded = encoded.replace(/%25([0-9a-fA-F]{2})/g, '%$1');
  return encoded.replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase());
}

/**
 * Parses a robots.txt (RFC 9309). Never throws; lines it does not understand are skipped.
 *
 * @param text the file as text
 * @returns the groups and their rules
 */
export function parseRobots(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // True while consecutive user-agent lines still add to the same group.
  let collectingAgents = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const field = fieldOf(rawLine);
    if (field === null) continue;
    const { key, value } = field;

    if (key === 'user-agent') {
      if (!collectingAgents || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
        collectingAgents = true;
      }
      if (value !== '') current.agents.push(value.toLowerCase());
      continue;
    }
    if (key === 'allow' || key === 'disallow') {
      collectingAgents = false;
      if (current === null) continue;
      // An empty path matches nothing (an empty Disallow allows everything).
      if (value === '') continue;
      current.rules.push({ allow: key === 'allow', pattern: normalizePath(value) });
      continue;
    }
    // Other keys (Sitemap, Crawl-delay, ...) end the user-agent run but carry no rule.
    collectingAgents = false;
  }
  return { groups };
}

/**
 * The key and value of one line, without its comment.
 *
 * @param rawLine the line as read
 * @returns the field; null for a line without a key
 */
function fieldOf(rawLine: string): RobotsField | null {
  const hash = rawLine.indexOf('#');
  const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  return { key: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
}

/**
 * Whether a group's user-agent value names the product token (`AssetForge`, `AssetForge/1.0`, ...).
 *
 * @param agent the lower-case user-agent value
 * @returns true when it names the product
 */
function namesProduct(agent: string): boolean {
  const token = agent.split(/[\s/]/, 1)[0] ?? '';
  return token === ROBOTS_PRODUCT_TOKEN;
}

/**
 * Whether `path` matches `pattern` from its start. Linear in time per star (greedy matching with one backtrack
 * point), so a pattern full of wildcards cannot stall the crawl.
 *
 * @param pattern the normalised pattern
 * @param path the normalised path
 * @returns true when the pattern matches
 */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  let patternIndex = 0;
  let pathIndex = 0;
  let starIndex = -1;
  let starPathIndex = 0;
  while (pathIndex < path.length) {
    if (patternIndex < body.length && body[patternIndex] !== '*' && body[patternIndex] === path[pathIndex]) {
      patternIndex++;
      pathIndex++;
    } else if (patternIndex < body.length && body[patternIndex] === '*') {
      starIndex = patternIndex++;
      starPathIndex = pathIndex;
    } else if (patternIndex === body.length && !anchored) {
      // The whole pattern matched a prefix.
      return true;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      pathIndex = ++starPathIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < body.length && body[patternIndex] === '*') patternIndex++;
  return patternIndex === body.length;
}

/**
 * Whether the rules allow `url`: the group for `AssetForge` (case-insensitive), else the `*` group, else everything
 * is allowed. Within the group the longest matching pattern wins and Allow wins a tie. A URL that cannot be parsed
 * is refused.
 *
 * @param rules the parsed robots.txt
 * @param url the URL to check
 * @returns true when the crawl may read it
 */
export function robotsAllows(rules: RobotsRules, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const path = normalizePath(`${parsed.pathname}${parsed.search}`);
  const best = bestRule(chosenGroups(rules), path);
  return best === null || best.allow;
}

/**
 * The groups that apply: those naming the product, else the `*` groups.
 *
 * @param rules the parsed robots.txt
 * @returns the groups; empty when none applies
 */
function chosenGroups(rules: RobotsRules): RobotsGroup[] {
  const chosen = rules.groups.filter((group) => group.agents.some(namesProduct));
  if (chosen.length > 0) return chosen;
  return rules.groups.filter((group) => group.agents.includes('*'));
}

/**
 * The deciding rule: the longest matching pattern, Allow winning a tie.
 *
 * @param groups the groups that apply
 * @param path the normalised path and query
 * @returns the rule; null when none matches
 */
function bestRule(groups: readonly RobotsGroup[], path: string): RobotsRule | null {
  let best: RobotsRule | null = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!matches(rule.pattern, path)) continue;
      if (best === null || beats(rule, best)) best = rule;
    }
  }
  return best;
}

/**
 * Whether a matching rule replaces the best one so far.
 *
 * @param rule the matching rule
 * @param best the best rule so far
 * @returns true for a longer pattern, or an Allow of the same length
 */
function beats(rule: RobotsRule, best: RobotsRule): boolean {
  if (rule.pattern.length > best.pattern.length) return true;
  return rule.pattern.length === best.pattern.length && rule.allow;
}
