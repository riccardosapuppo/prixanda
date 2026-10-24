// Limits on what one request may ask, as GraphQL validation rules: they run
// before anything reaches the engine, in Node through Apollo and, in stage 8,
// through graphql's own validate() in the browser.
//
// Depth counts nested fields. Cost estimates the work: each field costs 1,
// and a list multiplies what is selected inside it by its size: the `first`
// argument when the field is paged (its maximum when `first` is a variable,
// since validation runs before the variables are known), and an assumed size
// for the other lists. Aliases count one by one, so asking for the same
// expensive field a hundred times costs a hundred times. Introspection is not
// counted: the public schema turns it off in production.
import {
  type ASTVisitor, type FieldNode, getNamedType, getNullableType, GraphQLError, type GraphQLField, type GraphQLNamedType,
  isInterfaceType, isListType, isObjectType, Kind, type SelectionSetNode, type ValidationContext, type ValidationRule,
} from "graphql";

export type Limits = {
  readonly maxDepth: number;
  readonly maxCost: number;
  /** The size assumed for a list that has no `first` argument. */
  readonly assumedListSize: number;
  /** The largest `first` a paged field accepts. */
  readonly maxPage: number;
};

export const INTERNAL_LIMITS: Limits = { maxDepth: 10, maxCost: 25_000, assumedListSize: 10, maxPage: 100 };
export const PUBLIC_LIMITS: Limits = { maxDepth: 5, maxCost: 1_500, assumedListSize: 10, maxPage: 100 };

type Measure = { depth: number; cost: number };

function listSize(node: FieldNode, field: GraphQLField<unknown, unknown>, limits: Limits): number {
  if (!isListType(getNullableType(field.type))) return 1;
  const first = field.args.find((argument) => argument.name === "first");
  if (first === undefined) return limits.assumedListSize;
  const given = node.arguments?.find((argument) => argument.name.value === "first")?.value;
  if (given === undefined) return typeof first.defaultValue === "number" ? first.defaultValue : limits.maxPage;
  if (given.kind === Kind.INT) return Math.min(Number(given.value), limits.maxPage);
  return limits.maxPage;
}

/** The depth and cost of a selection, following fragments once each. */
export function measure(
  context: Pick<ValidationContext, "getFragment" | "getSchema">,
  selectionSet: SelectionSetNode,
  parent: GraphQLNamedType | undefined,
  limits: Limits,
  visiting: ReadonlySet<string> = new Set(),
): Measure {
  let depth = 0;
  let cost = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value.startsWith("__")) continue;
      const field = parent && (isObjectType(parent) || isInterfaceType(parent)) ? parent.getFields()[selection.name.value] : undefined;
      // An unknown field is another rule's to report.
      if (field === undefined) continue;
      if (selection.selectionSet) {
        const inner = measure(context, selection.selectionSet, getNamedType(field.type), limits, visiting);
        depth = Math.max(depth, 1 + inner.depth);
        cost += 1 + listSize(selection, field, limits) * inner.cost;
      } else {
        depth = Math.max(depth, 1);
        cost += 1;
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const type = selection.typeCondition ? context.getSchema().getType(selection.typeCondition.name.value) : parent;
      const inner = measure(context, selection.selectionSet, type ?? undefined, limits, visiting);
      depth = Math.max(depth, inner.depth);
      cost += inner.cost;
    } else {
      const name = selection.name.value;
      const fragment = context.getFragment(name);
      // A fragment that spreads itself is NoFragmentCyclesRule's to report.
      if (!fragment || visiting.has(name)) continue;
      const type = context.getSchema().getType(fragment.typeCondition.name.value);
      const inner = measure(context, fragment.selectionSet, type ?? undefined, limits, new Set([...visiting, name]));
      depth = Math.max(depth, inner.depth);
      cost += inner.cost;
    }
  }
  return { depth, cost };
}

export function depthAndCostRule(limits: Limits): ValidationRule {
  return (context: ValidationContext): ASTVisitor => ({
    OperationDefinition(operation) {
      const root = context.getSchema().getRootType(operation.operation) ?? undefined;
      const { depth, cost } = measure(context, operation.selectionSet, root, limits);
      if (depth > limits.maxDepth) {
        context.reportError(new GraphQLError(`This operation is ${depth} fields deep; the limit is ${limits.maxDepth}.`, { nodes: [operation] }));
      }
      if (cost > limits.maxCost) {
        context.reportError(new GraphQLError(
          `This operation would cost about ${cost} (each field 1, lists multiplied by their size); the limit is ${limits.maxCost}. Ask for fewer fields or smaller pages.`,
          { nodes: [operation] },
        ));
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
    const fields = rootFields(context, operation.selectionSet, new Set());
    if (fields > 1) {
      context.reportError(new GraphQLError(`One mutation per request: this one asks for ${fields}.`, { nodes: [operation] }));
    }
  },
});

function rootFields(context: ValidationContext, selectionSet: SelectionSetNode, visiting: ReadonlySet<string>): number {
  let fields = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) fields += selection.name.value === "__typename" ? 0 : 1;
    else if (selection.kind === Kind.INLINE_FRAGMENT) fields += rootFields(context, selection.selectionSet, visiting);
    else if (!visiting.has(selection.name.value)) {
      const fragment = context.getFragment(selection.name.value);
      if (fragment) fields += rootFields(context, fragment.selectionSet, new Set([...visiting, selection.name.value]));
    }
  }
  return fields;
}

export function limitRules(limits: Limits): ValidationRule[] {
  return [depthAndCostRule(limits), oneMutationRule];
}
