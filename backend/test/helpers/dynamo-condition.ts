// A small evaluator for the DynamoDB expressions that the webhook repository writes, so that
// the in-memory table (fake-table.ts) DECIDES what a ConditionExpression allows, as DynamoDB
// does, instead of comparing the text with a string it expects. A test then fails because of
// what the code DOES when its condition is wrong (for example a decision that overwrites a
// newer one, or an item that appears out of nowhere), not because a string differs.
//
// Supported: attribute_exists(x), attribute_not_exists(x), `x < :v` (also <=, >, >=, =, <>),
// AND, OR, and parentheses; SET a = :x, b = :y. Anything else throws, so a new kind of
// expression is noticed instead of silently accepted.

type Item = Record<string, unknown>;

interface Context {
  /** The stored item, or `undefined` when there is none. */
  item: Item | undefined;
  values: Record<string, unknown>;
  names: Record<string, string>;
}

// A token is a bracket, a comparison sign, or a word (an attribute name, #alias, :value or keyword).
const TOKEN = /<=|>=|<>|[()<>=]|[#:]?[A-Za-z_][A-Za-z0-9_.]*/g;

// `a.b` reads the attribute b inside the map a (the only nested path the webhook writes).
function valueAt(item: Item | undefined, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Item | undefined)?.[key], item);
}

export function evaluateCondition(expression: string, context: Context): boolean {
  const tokens = expression.match(TOKEN) ?? [];
  let position = 0;
  const next = (): string => tokens[position++] ?? "";
  const peekIs = (word: string): boolean => tokens[position]?.toUpperCase() === word;
  const fail = (): never => {
    throw new Error(`fake table: cannot evaluate the condition "${expression}"`);
  };
  const attribute = (token: string): string => (token.startsWith("#") ? (context.names[token] ?? fail()) : token);

  const or = (): boolean => {
    let result = and();
    while (peekIs("OR")) {
      next();
      const right = and();
      result = result || right;
    }
    return result;
  };
  const and = (): boolean => {
    let result = primary();
    while (peekIs("AND")) {
      next();
      const right = primary();
      result = result && right;
    }
    return result;
  };
  const primary = (): boolean => {
    const token = next();
    if (token === "(") {
      const inner = or();
      return next() === ")" ? inner : fail();
    }
    if (token === "attribute_exists" || token === "attribute_not_exists") {
      if (next() !== "(") fail();
      const name = attribute(next());
      if (next() !== ")") fail();
      const exists = context.item?.[name] !== undefined;
      return token === "attribute_exists" ? exists : !exists;
    }
    // a comparison: <attribute> <sign> <:value>
    const left = valueAt(context.item, attribute(token));
    const sign = next();
    const right = context.values[next()];
    // Comparing something that is not there is false, as in DynamoDB.
    if (left === undefined || right === undefined) return false;
    const [a, b] = [left as number, right as number];
    switch (sign) {
      case "<": return a < b;
      case "<=": return a <= b;
      case ">": return a > b;
      case ">=": return a >= b;
      case "=": return a === b;
      case "<>": return a !== b;
      default: return fail();
    }
  };

  const result = or();
  return position === tokens.length ? result : fail();
}

/** Applies `SET a = :x, b = :y` to the item. */
export function applySet(item: Item, expression: string, context: Pick<Context, "values" | "names">): void {
  const assignments = /^SET\s+(.+)$/.exec(expression)?.[1];
  if (assignments === undefined) throw new Error(`fake table: unsupported UpdateExpression "${expression}"`);
  for (const assignment of assignments.split(",")) {
    const [name, value] = assignment.split("=").map((part) => part.trim());
    if (name === undefined || value === undefined || !(value in context.values)) {
      throw new Error(`fake table: unsupported UpdateExpression "${expression}"`);
    }
    item[name.startsWith("#") ? (context.names[name] ?? name) : name] = structuredClone(context.values[value]);
  }
}
