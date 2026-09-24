# Working in this repo

This is a lead-generation application. The owner's build constraints below
apply to every change. Where the current code doesn't meet them yet, the gap is
recorded under **Known deviations** at the end; don't widen those gaps, and
don't close them without the owner's approval where the constraints require it.

## Stress-test every change

After building or changing anything (code, pages, workflows, schema, scripts),
and before committing or pushing it, run the `stress-tester` agent
(`.claude/agents/stress-tester.md`). Give it what changed and what the change
is meant to do. Fix every finding it reproduces, then run it again until the
verdict is SHIP or SHIP WITH NOTES. Include its verdict and any open notes in
the summary to the user.

---

# Build Negative Prompts & Architecture Constraints

## Core principle

Build the simplest architecture that satisfies the actual requirement.

Do not over-engineer the application before the core MVP works.

Prioritize:

1. Reliability
2. Data integrity
3. Security
4. Maintainability
5. Simplicity
6. Performance
7. Scalability when actually needed

Do not optimize for hypothetical future requirements at the expense of building
the current product well.

## Do not

- Do not over-engineer the application before the core MVP works.
- Do not introduce unnecessary services, databases, frameworks, or dependencies.
- Do not use multiple databases when one well-designed PostgreSQL database can handle the requirement.
- Do not replace Supabase/PostgreSQL with Cloudflare D1 unless there is a clearly documented technical reason.
- Do not duplicate the same data across multiple databases without a specific reason and synchronization strategy.
- Do not build custom authentication when Supabase Auth can handle the requirement.
- Do not expose database credentials, API keys, service-role keys, secrets, or environment variables to the client.
- Do not put privileged Supabase operations in client-side code.
- Do not hard-code API keys, credentials, URLs, or other secrets into source code.
- Do not create unnecessary API endpoints when an existing Supabase capability is sufficient.
- Do not make destructive database changes without first explaining the impact.
- Do not delete, rename, or migrate existing tables, columns, indexes, or data without explicit approval.
- Do not modify the database schema simply to make the code easier to write.
- Do not create duplicate tables or fields when an existing structure can be reused.
- Do not store the same piece of information in multiple places unless there is a documented reason.
- Do not sacrifice relational database integrity for convenience.
- Do not use free-text fields where a relational structure, foreign key, enum, or normalized table is more appropriate.
- Do not create overly complicated abstractions for simple CRUD operations.
- Do not add libraries just because they are popular; first determine whether the existing stack can solve the problem.
- Do not change the technology stack without explaining why the change is necessary.
- Do not rewrite working code unnecessarily.
- Do not refactor unrelated parts of the application while implementing a specific feature.
- Do not change UI/UX that I did not ask you to change.
- Do not remove functionality simply because it is not currently being used.
- Do not assume that a feature is unnecessary simply because it is not required for the current MVP.
- Do not make assumptions about business logic when the requirement is ambiguous. Ask or clearly state the assumption.
- Do not silently make architectural decisions that have long-term consequences.
- Do not optimize prematurely.
- Do not build for millions of users before the MVP has demonstrated the need.
- Do not add caching, queues, microservices, background workers, vector databases, or distributed systems unless the actual requirement justifies them.
- Do not use Cloudflare services merely because Cloudflare is available.
- Do not use Supabase features merely because they are available.
- Do not introduce complexity merely because a technology is capable of supporting it.

## Architecture principle

Supabase/PostgreSQL should remain the primary system of record for application
and lead data unless there is a documented technical requirement to change it.

Cloudflare should be introduced when it provides a specific, identifiable
benefit such as:

- Edge delivery
- Cloudflare Workers
- Caching
- R2 storage
- Queues
- Durable Objects
- Other Cloudflare infrastructure capabilities

Do not introduce Cloudflare D1 simply because it is available.

Do not introduce a second database simply because the application uses Cloudflare.

Avoid unnecessary synchronization between Supabase and Cloudflare.

The default architecture should favor a single source of truth.

## Supabase / database

Treat Supabase/PostgreSQL as the source of truth unless explicitly changed.

- Use foreign keys where relationships matter.
- Use indexes when justified by actual query patterns.
- Avoid unnecessary indexes.
- Preserve data integrity with appropriate constraints.
- Consider uniqueness constraints where duplicate records would create problems.
- Design the schema so it can grow without requiring a complete rewrite.
- Prefer normalized relational structures when the data is genuinely relational.
- Avoid storing relational data as JSON when a proper relational structure is more appropriate.
- Do not create duplicate tables simply because a new feature needs slightly different data.
- Before creating a new table, check whether an existing table can appropriately serve the purpose.
- Before creating a new column, check whether an existing field already represents the required information.
- Do not modify the schema merely for coding convenience.
- Do not create redundant representations of the same data without a documented reason.

## Database changes

Database changes require extra caution.

Before making a significant schema change:

1. Inspect the existing schema.
2. Determine what currently depends on the affected table, column, relationship, or index.
3. Explain the proposed change.
4. Explain potential consequences.
5. Prefer reversible changes.
6. Test the affected functionality afterward.

Do not:

- Drop tables without explicit approval.
- Drop columns without explicit approval.
- Rename columns without checking all dependencies.
- Delete production data without explicit approval.
- Rewrite large portions of the schema unnecessarily.
- Make destructive migrations merely to simplify development.

When there is a safer alternative to a destructive change, prefer the safer alternative.

## Security

Security should never be sacrificed for development convenience.

- Never expose Supabase service-role keys to the client.
- Never expose private API keys.
- Never hard-code secrets into source code.
- Never commit secrets to version control.
- Never expose environment variables containing secrets through the frontend.
- Never bypass authentication merely to make development easier.
- Never bypass authorization merely to make development easier.
- Never disable Row Level Security merely because it makes development more convenient.
- Never assume that knowing a database record ID gives a user permission to access it.
- Always validate authorization server-side.
- Protect private lead information.
- Protect personally identifiable information.
- Only expose the minimum data required for a given operation.

## Data safety

- Never expose personally identifiable information unnecessarily.
- Never expose private lead data to unauthorized users.
- Never bypass Row Level Security for convenience.
- Never disable security controls to make development easier.
- Never use production data for testing when synthetic/test data will work.
- Never permanently delete data when soft deletion or archival is more appropriate.
- Never assume that a user has permission to access a record merely because they know its ID.
- Always validate authorization server-side.
- Preserve historical information when it is important to business operations.
- Do not silently overwrite important lead history.

## Authentication

Prefer established authentication functionality provided by the existing architecture.

If Supabase Auth is being used:

- Do not build a second authentication system without a specific reason.
- Do not duplicate user identity data unnecessarily.
- Keep authentication separate from application-specific user/profile information.
- Never expose privileged authentication credentials to the client.
- Enforce authorization independently of authentication.

Authentication answers: "Who is this user?"

Authorization answers: "What is this user allowed to do?"

Do not treat them as the same problem.

## Code quality

- Prefer simple, readable code.
- Reuse existing patterns in the application.
- Avoid unnecessary abstractions.
- Avoid premature optimization.
- Avoid unnecessary design patterns.
- Avoid duplicate logic.
- Keep functions reasonably focused.
- Keep components reasonably focused.
- Use clear names.
- Preserve existing conventions unless there is a good reason to change them.
- Do not rewrite functioning code without a meaningful benefit.
- Do not refactor unrelated code while implementing a feature.
- Keep changes as localized as reasonably possible.

## Dependencies

Before adding a dependency:

1. Determine whether the current stack can already accomplish the task.
2. Determine whether an existing dependency can accomplish the task.
3. Determine whether the new dependency provides enough value to justify the added complexity.
4. Consider maintenance and security implications.

Do not add a library simply because it is popular.

Do not add a framework simply because it is trendy.

Do not introduce an external service for functionality that can be handled
cleanly by the existing architecture.

## Cloudflare

Cloudflare should solve a specific problem.

Potential legitimate uses include:

- Hosting/delivery
- CDN
- Edge computing
- Workers
- Caching
- R2 object storage
- Queues
- Durable Objects
- Other infrastructure requirements that benefit from Cloudflare's platform

Do not use Cloudflare merely because it is available.

Do not automatically move database functionality into Cloudflare.

Do not introduce D1 simply because the application uses Cloudflare Workers.

Do not create unnecessary synchronization between Supabase, D1, KV, R2, or
other data stores.

Every additional persistent data store should have a clear reason for existing.

## Single source of truth

Whenever possible, each important piece of information should have one
authoritative source. For example:

- Lead information → primary database
- User identity → authentication system
- Large files → designated object storage
- Application configuration → designated configuration/environment system

Do not maintain multiple competing versions of the same information unless
there is a clear architectural reason.

If data must exist in multiple places:

- Document why.
- Define which system is authoritative.
- Define how synchronization occurs.
- Define what happens when synchronization fails.

## Development process

Before implementing a significant feature:

1. Inspect the existing architecture.
2. Understand how similar functionality is currently implemented.
3. Identify existing tables, components, functions, APIs, and services that could be reused.
4. Determine the smallest change that can satisfy the requirement.
5. Implement the change.
6. Test the affected functionality.
7. Report what was changed and what was tested.

Do not immediately create new infrastructure.

Do not assume a new system is necessary.

Reuse existing architecture whenever reasonably possible.

## Ambiguity

When requirements are ambiguous, do not silently guess when the decision could
materially affect database structure, security, data integrity,
authentication, authorization, long-term architecture, existing functionality,
or user experience.

Instead:

1. Identify what is uncertain.
2. Explain the relevant options.
3. Recommend the simplest option based on the current architecture.
4. Ask for confirmation when the decision has significant consequences.

For small, reversible implementation details, use reasonable judgment rather
than unnecessarily stopping development.

## Feature development

Before implementing a new feature:

- Determine whether the current architecture already supports it.
- Determine whether existing functionality can be extended.
- Check whether an existing table can store the required information.
- Check whether an existing component can be extended.
- Check whether an existing API can be reused.
- Avoid creating parallel systems.

Do not create a new pattern when an existing pattern already works.

Do not create a new database table when an existing relational structure can
appropriately handle the requirement.

Do not create a new service when the current stack can reasonably handle the task.

## UI / UX

- Do not change UI/UX that was not part of the requested feature.
- Do not remove existing functionality without approval.
- Do not redesign the application merely because you personally prefer another design.
- Preserve existing interaction patterns where possible.
- Do not sacrifice usability for technical convenience.
- Do not make major visual changes while implementing unrelated backend functionality.
- If a UI change is technically necessary, explain why.

## Performance

Optimize based on actual requirements and measured problems.

Do not prematurely introduce complex caching, distributed systems, message
queues, microservices, multiple databases, background processing, vector
databases, complex indexing strategies, or advanced edge architectures unless
the actual application requirements justify them.

Start simple. Scale specific components when actual usage demonstrates the need.

## Testing

- Test changes that affect functionality.
- Test database changes.
- Test authentication and authorization changes.
- Test important edge cases.
- Do not claim something works unless it has actually been tested.
- Do not fabricate test results.
- Do not fabricate API responses.
- Do not fabricate database records.
- Do not claim an integration is working if it has not been verified.
- Clearly distinguish between: **Implemented**, **Tested**, **Not tested**,
  **Assumed**, **Blocked**.

## Honesty about implementation

Never pretend that something has been completed when it has not.

Never fabricate API responses, database records, test results, external
service behavior, integration status, performance measurements, user activity,
lead information, or enrichment results.

If something cannot currently be verified, say so clearly.

If something is an assumption, label it as an assumption.

If something is a placeholder, label it as a placeholder.

## Architectural decision rule

When multiple technical approaches are possible, prefer the approach that:

1. Uses the existing architecture.
2. Uses fewer moving parts.
3. Keeps data in one authoritative location.
4. Preserves security.
5. Preserves data integrity.
6. Is easy to understand.
7. Is easy to maintain.
8. Can be expanded later if necessary.

Do not choose a more complicated architecture simply because it is more
technically sophisticated.

## Final rule

The goal is not to use every available technology.

The goal is to build a reliable, secure, maintainable lead-generation
application with the fewest unnecessary moving parts.

Simple first. Powerful when necessary.

Supabase/PostgreSQL should generally remain the system of record.

Cloudflare should be added when it solves a specific infrastructure or edge problem.

Every new service, database, dependency, abstraction, or architectural layer
should have a clear reason to exist.

---

# Known deviations (current state vs. the constraints above)

Recorded so they are visible, not silently accepted. Each needs the owner's
decision before it is changed, because closing it removes or migrates
something that works today.

1. **Two databases during the move (D1 and Postgres).** Production still runs
   on Cloudflare D1. The code can use Postgres (`pg.js`) and falls back to D1
   when no Postgres connection is configured.
   - Why: the move to Supabase/Postgres is in progress; the Supabase project
     isn't created yet.
   - Authoritative: D1 until the Worker secret `POSTGRES_PRIMARY` is `true`;
     Postgres from then on. A configured connection alone switches nothing.
   - Sync: none. It is a one-way, one-time copy (`copy-to-postgres.js`, safe to
     repeat). If a copy run fails, D1 is untouched and the copy is re-run.
   - End state: after the switch is verified, remove the D1 binding, the D1
     fallback, `copy-to-postgres.js` and `/api/admin/copy-to-postgres`.
2. **A third, older data path: the Supabase REST adapter** (`supabaseAdapter`
   in `db.js`). It covers only part of the app, and the direct Postgres path
   replaces it. Candidate for removal once Postgres is live.
3. **Custom password authentication.** Accounts sign in with passwords the
   Worker hashes itself (PBKDF2), alongside optional Supabase magic links. The
   constraints prefer Supabase Auth. Moving every account to Supabase Auth is a
   significant change to sign-in and needs a decision.
4. **Weak initial passwords for the bulk-created creators.** They are the
   person's lowercase first name, as the owner asked, and the naming scheme is
   documented in this public repository. There is no self-service password
   change and no sign-in rate limit yet.
5. **Hard-coded site URL** in several workflows, `public/app.js` and
   `package.json` (`faith-journey-funnel.faith-journey-funnel.workers.dev`).
   Not a secret, but it should come from configuration.
6. **New dependency and Cloudflare service for the Postgres connection:** the
   `postgres` driver, plus Hyperdrive (recommended, not yet created).
   - Why: `platform.js` and `db.js` hold about 100 SQL queries, including
     aggregations. Supabase's REST API can't express GROUP BY, so reaching the
     same database over REST would mean rewriting them.
   - Hyperdrive: Workers can't keep a database connection between requests,
     so without it every request pays for a new database login.
7. **The local development server** (`server.js`, `npm start`) keeps its own
   SQLite file (`data/funnel.db`). It never runs in production and holds only
   local test data.

# Assumptions awaiting the owner's confirmation

Business-logic decisions made during the Postgres work. Each is small and
reversible; confirm or change them.

1. **A response through a link to a creator that doesn't exist** (a typo, or a
   removed creator) is saved under `default`, the collective, instead of being
   rejected. Before this, D1 stored it under the unknown name and Postgres
   refused it. The name typed in the link is not kept.
   - This differs from the one-time copy on purpose: there, existing leads for
     a creator who has since been removed keep their link, through an
     archived, unlisted placeholder creator, so that history is preserved.
2. **One creator per email address.** Registering a second creator with an
   email that is already in use is refused (409) on both databases, because
   sign-in finds a creator by email. D1 used to allow it.
