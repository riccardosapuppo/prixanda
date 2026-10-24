// Puts the resolvers onto a schema built from its SDL, with nothing but the
// graphql package, so the same code builds the schema in Node and, in stage
// 8, in a browser. Strict both ways: a resolver for a field the schema lacks
// is refused (a typo would otherwise be ignored), and so is a schema field,
// union or scalar left without its resolver.
import {
  type GraphQLFieldResolver, GraphQLScalarType, type GraphQLSchema, type GraphQLTypeResolver, isEnumType, isInputObjectType, isObjectType,
  isScalarType, isUnionType, specifiedScalarTypes,
} from "graphql";

type FieldResolver = GraphQLFieldResolver<unknown, unknown> | { resolve: GraphQLFieldResolver<unknown, unknown> };

export function bindResolvers(schema: GraphQLSchema, resolvers: object, label: string): GraphQLSchema {
  const problems: string[] = [];
  for (const [typeName, given] of Object.entries(resolvers) as Array<[string, unknown]>) {
    const type = schema.getType(typeName);
    if (type === undefined) {
      problems.push(`${typeName} is not a type of the ${label} schema`);
    } else if (isScalarType(type)) {
      if (!(given instanceof GraphQLScalarType) || given.name !== typeName) {
        problems.push(`scalar ${typeName} needs its GraphQLScalarType`);
        continue;
      }
      type.serialize = given.serialize;
      type.parseValue = given.parseValue;
      type.parseLiteral = given.parseLiteral;
    } else if (isObjectType(type)) {
      const fields = type.getFields();
      for (const [fieldName, resolver] of Object.entries(given as Record<string, FieldResolver>)) {
        const field = fields[fieldName];
        if (field === undefined) {
          problems.push(`${typeName}.${fieldName} is not a field of the ${label} schema`);
          continue;
        }
        field.resolve = typeof resolver === "function" ? resolver : resolver.resolve;
      }
    } else if (isUnionType(type)) {
      const { __resolveType: resolveType, ...rest } = given as { __resolveType?: GraphQLTypeResolver<unknown, unknown> };
      if (typeof resolveType !== "function" || Object.keys(rest).length) problems.push(`union ${typeName} takes __resolveType only`);
      else type.resolveType = resolveType;
    } else {
      problems.push(`${typeName} takes no resolvers`);
    }
  }
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith("__")) continue;
    if (isObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        if (field.resolve === undefined) problems.push(`${type.name}.${field.name} has no resolver`);
      }
    } else if (isUnionType(type)) {
      if (type.resolveType === undefined || type.resolveType === null) problems.push(`union ${type.name} has no __resolveType`);
    } else if (isScalarType(type) && !specifiedScalarTypes.some((builtIn) => builtIn.name === type.name)) {
      if (!Object.hasOwn(resolvers, type.name)) problems.push(`scalar ${type.name} has no implementation`);
    } else if (!isEnumType(type) && !isInputObjectType(type) && !isScalarType(type)) {
      problems.push(`${type.name} is of a kind the gateway does not bind`);
    }
  }
  if (problems.length) throw new Error(`the ${label} schema and its resolvers do not match:\n  ${problems.join("\n  ")}`);
  return schema;
}
