// A union's members are asked for in one selection: `... on A { x } ... on B
// { x }`. GraphQL accepts that only when the fields of the same name give the
// same shape in the response (its OverlappingFieldsCanBeMerged rule); where
// they do not, every client needs an alias. This finds those fields, so that a
// schema does not ship one.
import {
  getNamedType, type GraphQLNamedType, type GraphQLOutputType, type GraphQLSchema, isLeafType, isListType, isNonNullType, isObjectType,
  isUnionType,
} from "graphql";

/** Why two fields of the same name cannot be asked for side by side, or null when they can. */
function conflict(a: GraphQLOutputType, b: GraphQLOutputType, compared: Set<string>): string | null {
  if (isNonNullType(a) || isNonNullType(b)) {
    return isNonNullType(a) && isNonNullType(b) ? conflict(a.ofType, b.ofType, compared) : `${String(a)} and ${String(b)}`;
  }
  if (isListType(a) || isListType(b)) return isListType(a) && isListType(b) ? conflict(a.ofType, b.ofType, compared) : `${String(a)} and ${String(b)}`;
  if (isLeafType(a) || isLeafType(b)) return a === b ? null : `${String(a)} and ${String(b)}`;
  return subFields(getNamedType(a), getNamedType(b), compared);
}

/** Two object types under fields of the same name: their own fields of the same name must agree too. */
function subFields(a: GraphQLNamedType, b: GraphQLNamedType, compared: Set<string>): string | null {
  const pair = `${a.name}/${b.name}`;
  if (a === b || compared.has(pair) || !isObjectType(a) || !isObjectType(b)) return null;
  compared.add(pair);
  const theirs = b.getFields();
  for (const field of Object.values(a.getFields())) {
    const other = theirs[field.name];
    const found = other ? conflict(field.type, other.type, compared) : null;
    if (found) return `${a.name}.${field.name} and ${b.name}.${field.name}: ${found}`;
  }
  return null;
}

/** The fields of a union's members that share a name but not a shape, each said once. */
export function unionConflicts(schema: GraphQLSchema): string[] {
  const conflicts: string[] = [];
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isUnionType(type)) continue;
    const seen = new Map<string, { member: string; type: GraphQLOutputType }>();
    for (const member of type.getTypes()) {
      for (const field of Object.values(member.getFields())) {
        const known = seen.get(field.name);
        if (known === undefined) {
          seen.set(field.name, { member: member.name, type: field.type });
          continue;
        }
        const found = conflict(known.type, field.type, new Set());
        if (found) conflicts.push(`${type.name}: ${known.member}.${field.name} and ${member.name}.${field.name}, ${found}`);
      }
    }
  }
  return conflicts;
}
