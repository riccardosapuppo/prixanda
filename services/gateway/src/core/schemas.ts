// The two executable schemas, built from the SDL written first
// (schema/*.graphql, embedded by tools/graphql.ts) and the resolvers, with
// the graphql package only: no Node, no Apollo. The Node shell serves them
// through Apollo Server; the browser of stage 8 will execute them directly.
import { buildSchema, type GraphQLSchema } from "graphql";
import { bindResolvers } from "./bind.ts";
import { internalSdl, publicSdl } from "./generated/sdl.ts";
import { internalResolvers } from "./internal/resolvers.ts";
import { guardInternalSchema, guardPublicSchema } from "./policy.ts";
import { publicResolvers } from "./public/resolvers.ts";

/** The console's schema, every root field behind its access rule. */
export function buildInternalSchema(): GraphQLSchema {
  const schema = bindResolvers(buildSchema(internalSdl), internalResolvers, "console's");
  guardInternalSchema(schema);
  return schema;
}

/** The site's schema: public, except what acts for the listener of the site's session. */
export function buildPublicSchema(): GraphQLSchema {
  const schema = bindResolvers(buildSchema(publicSdl), publicResolvers, "site's");
  guardPublicSchema(schema);
  return schema;
}
