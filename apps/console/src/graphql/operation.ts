// An operation of the console's API, as the generated code describes it: its
// name, whether it reads or changes something, and its whole text (the
// operation with every fragment it uses). The result and variable types ride
// along in the type only, so a transport cannot mix them up.
//
// Text, not a parsed document: the HTTP transport sends it as it is, and the
// transport of stage 8, which runs the schema in the page, parses it there.
export type Operation<TData, TVariables> = {
  readonly name: string;
  readonly kind: "query" | "mutation";
  readonly text: string;
  /** Never set: carries the types of the result and of the variables. */
  readonly __types?: (variables: TVariables) => TData;
};

export type ResultOf<O> = O extends Operation<infer TData, unknown> ? TData : never;
export type VariablesOf<O> = O extends Operation<unknown, infer TVariables> ? TVariables : never;

/** The key a query is cached under: the operation's name and its variables. */
export function queryKeyOf<TVariables>(operation: Operation<unknown, TVariables>, variables: TVariables): readonly unknown[] {
  return [operation.name, variables];
}
