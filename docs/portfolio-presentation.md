# Portfolio presentation

How this project is described wherever it appears: the README, the
repository's description, the author's portfolio and CV.

## What it is

An independent personal software project by Riccardo Sapuppo: a subscription
and pricing operations platform, provisionally named Plancia. Nobody
commissioned it, it has no customers, and no company is behind it. It is not
client work and is not connected to any streaming service.

The platform governs prices per market, promotions, prepaid passes and price
changes for existing subscribers, over the plans of its catalog, with
simulation, approvals bound to exact versions, safe launches and an audit
log. It is explored through
Rione, a fictional independent-music streaming service, with synthetic data.
The interactive sandbox runs the same engine in a browser so that anyone can
try it without installing anything.

## The sentence it supports

> I designed and built an independent software platform for managing
> subscriptions, prices, promotions and commercial approvals across several
> markets. It includes real services, verified workflows, audit controls and
> recovery mechanisms. To make it easy to try, I built an interactive sandbox
> around a fictional music service and synthetic data.

Each part of it points to something in the repository:

| Claim | Where it is checked |
|---|---|
| real services | the Python engine behind gRPC, the GraphQL gateway, PostgreSQL with Flyway migrations ([product-status.md](product-status.md)) |
| verified workflows | the six scenarios against the real engine and PostgreSQL, end to end in a browser, in the console, on the site or both, run by `npm test`, the command the CI runs on Linux and Windows |
| audit controls | the append-only, hash-chained audit log and its verification; separation of duties enforced by the engine and the database |
| recovery mechanisms | launches that resume after a crash; the fault tests that count zero partial activations |
| the sandbox | the same engine on Pyodide, PGlite with the same migrations, and the schema parity test |

## Words to use and words to avoid

Use: personal project; independent platform; fictional business scenario;
synthetic dataset; interactive sandbox; simulated payment provider; designed
around SOX-style separation of duties and auditable approval controls.

Avoid: client, customers, users, production, in use, compliant, certified,
secure (on its own), clone, and anything that suggests a link with a real
streaming service. The "customer data" of the disclaimer is that of the
fictional business, and it is synthetic. The project is "open source" only once the repository is
public under an open-source licence.

## Numbers

Only measured numbers, each with the command that produces it, the size of
the data and the machine: the counts of `npm test`, the faults injected and
the partial activations they left, the query timings of `npm run measure`,
and the sandbox's first load. They are in the README. They come from
synthetic data on one development machine and are not production figures.

## What was new

Before this project the author had worked with React, TypeScript, Next.js,
Python and SQL databases, PostgreSQL among them, at different depths, and
with Tailwind CSS, Playwright and GitHub Actions. GraphQL and gRPC are what
the author set out to learn, and learned here. The other tools the project
relies on are named without a claim of earlier experience, and nothing in
the project is presented as years of professional experience.
