// Limits on what one request may ask, as GraphQL validation rules: they run
// before anything reaches the engine, in Node through Apollo and, in stage 8,
// through graphql's own validate() in the browser.
//
// Depth counts nested fields. Cost estimates the work: each field costs 1,
// and a list multiplies what is selected inside it by its size: the `first`
// argument when the field is paged (its maximum when `first` is a variable,
// since validation runs before the variables are known), and an assumed size
// for the other lists. A page counts one row at least, so no field lowers the
// cost of the others. Aliases count one by one, so asking for the same
// expensive field a hundred times costs a hundred times. A field under @skip
// or @include counts as if it ran: whether it runs is known only later.
// Introspection is not counted: the public schema turns it off in production.
//
// A `first` written in the document is checked here too, between 1 and the
// largest page: a field that @skip leaves out never reaches its resolver's
// own check, and a size the resolver would refuse must not be counted either.
import {
  type ASTVisitor, type FieldNode, getNamedType, getNullableType, GraphQLError, type GraphQLField, type GraphQLNamedType,
  type GraphQLSchema, isInterfaceType, isListType, isObjectType, isUnionType, Kind, type SelectionSetNode, type ValidationContext,
  type ValidationRule,
} from "graphql";

export type Limits = {
  readonly maxDepth: number;
  readonly maxCost: number;
  /** The size assumed for a list that has no `first` argument. */
  readonly assumedListSize: number;
  /** The largest `first` a paged field accepts. */
  readonly maxPage: number;
};

// The depths are the schemas' own deepest paths (deepestPath(), checked by a
// test): on the site, a listener's account, its payment and the payment's
// receipt, five deep. The costs leave room for the console's largest page of changes with
// their details (about 22,400) and for the site's whole catalog of a market
// (about 330), and none for the same fields asked again and again through
// aliases: on the site each alias of a list is one more call to the engine.
export const INTERNAL_LIMITS: Limits = { maxDepth: 8, maxCost: 25_000, assumedListSize: 10, maxPage: 100 };
export const PUBLIC_LIMITS: Limits = { maxDepth: 5, maxCost: 600, assumedListSize: 10, maxPage: 100 };

type Measure = { depth: number; cost: number };

/** A page's size as the estimate counts it: from 1 row to the largest page. */
function pageSize(rows: number, limits: Limits): number {
  return Math.max(1, Math.min(rows, limits.maxPage));
}

/**
 * The page a field asks for: its `first` argument as written, the field's
 * default when it is left out, the largest page when it is a variable. Never
 * fewer than 1 row: a page of minus two billion rows, under @skip so that it
 * never runs, would otherwise take its cost away from the rest of the
 * operation.
 */
function pageOf(node: FieldNode, field: GraphQLField<unknown, unknown>, limits: Limits): number | undefined {
  const first = field.args.find((argument) => argument.name === "first");
  if (first === undefined) return undefined;
  const given = node.arguments?.find((argument) => argument.name.value === "first")?.value;
  if (given === undefined) return typeof first.defaultValue === "number" ? pageSize(first.defaultValue, limits) : limits.maxPage;
  if (given.kind === Kind.INT) return pageSize(Number(given.value), limits);
  return limits.maxPage;
}

/** Each fragment's measure, once per operation and per page it is read at. */
type Memo = Map<string, Measure>;

/**
 * The depth and cost of a selection. A paged field (one with `first`) returns
 * a page whose list of nodes is as long as the page: `page` carries that size
 * down to the lists directly inside it.
 *
 * A fragment is measured once per operation and page, however many times it
 * is spread: fragments that spread a fragment twice, level after level, would
 * otherwise double the work at every level before any limit is checked. And
 * the count stops as soon as it passes a limit, since the answer is then
 * known: past the limit, depth and cost are lower bounds.
 *
 * Directives are not read: a field, a fragment or a spread under @skip or
 * @include counts with what it would cost if it ran, the most it can cost.
 */
export function measure(
  context: Pick<ValidationContext, "getFragment" | "getSchema">,
  selectionSet: SelectionSetNode,
  parent: GraphQLNamedType | undefined,
  limits: Limits,
  visiting: ReadonlySet<string> = new Set(),
  page?: number,
  memo: Memo = new Map(),
): Measure {
  let depth = 0;
  let cost = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value.startsWith("__")) continue;
      const field = parent && (isObjectType(parent) || isInterfaceType(parent)) ? parent.getFields()[selection.name.value] : undefined;
      // An unknown field is another rule's to report.
      if (field === undefined) continue;
      const paged = pageOf(selection, field, limits);
      const isList = isListType(getNullableType(field.type));
      const size = isList ? (paged ?? page ?? limits.assumedListSize) : 1;
      if (selection.selectionSet) {
        const inner = measure(context, selection.selectionSet, getNamedType(field.type), limits, visiting, isList ? undefined : paged, memo);
        depth = Math.max(depth, 1 + inner.depth);
        cost += 1 + size * inner.cost;
      } else {
        depth = Math.max(depth, 1);
        cost += 1;
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const type = selection.typeCondition ? context.getSchema().getType(selection.typeCondition.name.value) : parent;
      const inner = measure(context, selection.selectionSet, type ?? undefined, limits, visiting, page, memo);
      depth = Math.max(depth, inner.depth);
      cost += inner.cost;
    } else {
      const name = selection.name.value;
      const fragment = context.getFragment(name);
      // A fragment that spreads itself is NoFragmentCyclesRule's to report.
      if (!fragment || visiting.has(name)) continue;
      const key = `${name}@${page ?? ""}`;
      let inner = memo.get(key);
      if (inner === undefined) {
        const type = context.getSchema().getType(fragment.typeCondition.name.value);
        inner = measure(context, fragment.selectionSet, type ?? undefined, limits, new Set([...visiting, name]), page, memo);
        memo.set(key, inner);
      }
      depth = Math.max(depth, inner.depth);
      cost += inner.cost;
    }
    if (depth > limits.maxDepth || cost > limits.maxCost) break;
  }
  return { depth, cost };
}

export function depthAndCostRule(limits: Limits): ValidationRule {
  return (context: ValidationContext): ASTVisitor => ({
    OperationDefinition(operation) {
      const root = context.getSchema().getRootType(operation.operation) ?? undefined;
      const { depth, cost } = measure(context, operation.selectionSet, root, limits);
      if (depth > limits.maxDepth) {
        context.reportError(new GraphQLError(`This operation is ${depth} fields deep or more; the limit is ${limits.maxDepth}.`, { nodes: [operation] }));
      }
      if (cost > limits.maxCost) {
        context.reportError(new GraphQLError(
          `This operation would cost more than ${limits.maxCost} (each field 1, lists multiplied by their size). Ask for fewer fields or smaller pages.`,
          { nodes: [operation] },
        ));
      }
    },
  });
}

/**
 * A page asked for with a `first` written in the document has between 1 row
 * and the largest page, or the request is refused before anything runs. The
 * resolvers check a size that comes in a variable when they run; a field that
 * @skip leaves out never runs, so for a written size this is the check that
 * holds, skipped or not.
 */
export function pageSizeRule(limits: Limits): ValidationRule {
  return (context) => ({
    Argument(node) {
      if (node.name.value !== "first" || node.value.kind !== Kind.INT) return;
      // A field's argument, known to the schema: a directive's, or an unknown one, is not a page.
      if (context.getDirective() !== null || context.getArgument() === null || context.getFieldDef() === null) return;
      const rows = Number(node.value.value);
      if (rows < 1 || rows > limits.maxPage) {
        context.reportError(new GraphQLError(`first must be between 1 and ${limits.maxPage}: ${node.value.value.slice(0, 24)} is not a page size.`, { nodes: [node] }));
      }
    },
  });
}

/**
 * One mutation per request: each one carries its own Idempotency-Key to the
 * engine, and a key names exactly one action.
 */
export const oneMutationRule: ValidationRule = (context) => ({
  OperationDefinition(operation) {
    if (operation.operation !== "mutation") return;
    if (rootFields(context, operation.selectionSet, new Set(), new Map()) > 1) {
      context.reportError(new GraphQLError("One mutation per request: this one asks for more.", { nodes: [operation] }));
    }
  },
});

/**
 * How many root fields a selection asks for, up to the second: one is
 * allowed, and past it the answer is known. Each fragment is counted once.
 */
function rootFields(context: ValidationContext, selectionSet: SelectionSetNode, visiting: ReadonlySet<string>, memo: Map<string, number>): number {
  let fields = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) fields += selection.name.value === "__typename" ? 0 : 1;
    else if (selection.kind === Kind.INLINE_FRAGMENT) fields += rootFields(context, selection.selectionSet, visiting, memo);
    else if (!visiting.has(selection.name.value)) {
      const name = selection.name.value;
      let inner = memo.get(name);
      if (inner === undefined) {
        const fragment = context.getFragment(name);
        inner = fragment ? rootFields(context, fragment.selectionSet, new Set([...visiting, name]), memo) : 0;
        memo.set(name, inner);
      }
      fields += inner;
    }
    if (fields > 1) break;
  }
  return fields;
}

export function limitRules(limits: Limits): ValidationRule[] {
  return [depthAndCostRule(limits), pageSizeRule(limits), oneMutationRule];
}

/**
 * The deepest selection a schema allows, in fields, or Infinity when its types
 * point back at each other. Both schemas are acyclic today, so this bounds
 * every query they accept; the depth limit is set at it, and stops the runaway
 * queries a cycle added later would allow.
 */
export function deepestPath(schema: GraphQLSchema): number {
  const deepest = (type: GraphQLNamedType, seen: ReadonlySet<string>): number => {
    if (isUnionType(type)) return Math.max(0, ...type.getTypes().map((member) => deepest(member, seen)));
    if (!isObjectType(type)) return 0;
    if (seen.has(type.name)) return Number.POSITIVE_INFINITY;
    const next = new Set([...seen, type.name]);
    let best = 0;
    for (const field of Object.values(type.getFields())) best = Math.max(best, 1 + deepest(getNamedType(field.type), next));
    return best;
  };
  const roots = [schema.getQueryType(), schema.getMutationType()].filter((root) => root !== null && root !== undefined);
  return Math.max(0, ...roots.map((root) => deepest(root, new Set())));
}
