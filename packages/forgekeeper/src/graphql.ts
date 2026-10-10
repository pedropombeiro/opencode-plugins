// Types for the GraphQL calls that `gh` and `glab` make. A query's text is
// paired with the shape of the response `data` it asks for, so each call site
// gets typed results, and the response shape sits next to the query that
// determines it.
declare const shape: unique symbol;

export type Query<Data> = string & { readonly [shape]?: Data };

// The shape is a claim about what the server returns for this text: nothing
// checks it at runtime, so write it from the query's selection.
export const query = <Data>(text: string): Query<Data> => text as Query<Data>;

// Runs a query and returns the response's `data`. The forges' transports can
// only vouch that it parsed, so they return `unknown`.
export type Transport<Variables> = (
  host: string,
  query: string,
  variables: Variables,
) => Promise<unknown>;

export type Typed<Variables> = <Data>(
  host: string,
  query: Query<Data>,
  variables: Variables,
) => Promise<Data>;

// The one place that trusts a query's declared shape.
export const typed =
  <Variables>(transport: Transport<Variables>): Typed<Variables> =>
  async <Data>(host: string, query: Query<Data>, variables: Variables) =>
    (await transport(host, query, variables)) as Data;
