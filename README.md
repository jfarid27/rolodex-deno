# rolodex

A small terminal-based contacts manager. Two interchangeable storage backends,
four subcommands, no server. The whole interface is `deno task rolodex`.

## Install

Requires [Deno](https://deno.com) 2.x.

### Default: file-backed JSON store

```bash
git clone <repo-url> rolodex
cd rolodex
echo 'DB_FILE_LOCATION="./data.json"' > .env
touch data.json
```

The `data.json` file can be empty — the CLI seeds it on first run.

### MongoDB

See the [Adapters](#adapters) section for env vars and permission flags. The
Mongo adapter is opt-in: you wire it in `services/index.ts` (or compose it
manually) instead of the file-backed adapter.

## Usage

```bash
deno task rolodex help
deno task rolodex create '{"firstName":"Ada","lastName":"Lovelace","phoneNumbers":["+44-0"],"emails":["ada@example.com"],"tags":["math","computing"],"note":"first programmer"}'
deno task rolodex search --name ada
deno task rolodex search --id   6a46ebbc5d3cdd56844aba92
deno task rolodex search --tag  computing
deno task rolodex update 6a46ebbc5d3cdd56844aba92 '{"note":"analytical engine","tags":["math","computing","history"]}'
```

Subcommands:

| command                      | description                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `search --name <query>`      | Case-insensitive substring match on first/last name.                                            |
| `search --id <id>`           | Exact id match.                                                                                 |
| `search --tag <query>`       | Case-insensitive substring match on any tag.                                                    |
| `create <contact-json>`      | Insert a contact. Id is auto-assigned; ignore it.                                               |
| `update <id> <contact-json>` | Apply a partial patch to the contact with the given id. Only the fields you supply are changed. |
| `help`                       | Print the full help text.                                                                       |

Exit codes: `0` success, `1` runtime error (DB, invalid JSON, schema mismatch),
`2` usage error (bad flags, missing args, unknown subcommand).

## Update semantics

`update` is a **partial** patch, not a full replacement. Send only the fields
you want to change; everything else on the record is preserved:

```bash
# Change just the note; phones, emails, tags, and names are untouched.
deno task rolodex update 6a46ebbc5d3cdd56844aba92 '{"note":"analytical engine"}'

# Change multiple fields at once.
deno task rolodex update 6a46ebbc5d3cdd56844aba92 '{"note":"x","tags":["a","b"]}'

# An empty patch `{}` is valid and a no-op (just re-renders the record).
```

Rules:

- The row is matched by the command-line `<id>`, not by any `id` in the patch. A
  patch's `id` field is accepted for type-compatibility but is always ignored —
  the original id is preserved so a record cannot be re-anchored to a different
  row.
- Each field you supply is type-checked against the same schema as `create`
  (e.g. `tags` must be a string array if present), but missing fields are
  allowed. Supplying the wrong type for a field produces a schema error (exit 1)
  and the record is left unchanged.
- An unknown id produces a friendly error (exit 1) and the database is not
  touched.

## Cross-field search

The `DBService` port exposes a generic `searchContacts(query)` method that
matches the query as a case-insensitive substring against any of: `firstName`,
`lastName`, any `tag`, and the `note`. Every contact that hits on at least one
of those fields is returned.

This is not currently wired to a CLI subcommand — the CLI's `search` command
still takes a single `--name` / `--id` / `--tag` flag. The method is on the port
for programmatic use (e.g. from a script that composes the `DBService` layer
directly) and to keep the two adapters' behavior identical at the API level.

Both adapters implement `searchContacts`:

- **File adapter**: filters the in-memory contact list with a per-field
  substring check.
- **MongoDB adapter**: issues a single `$or` regex query across the four fields,
  then re-applies the same per-field substring filter in the application layer
  (so the two adapters return identical results for the same data).

## Contact shape

The `create` command takes a JSON object matching this schema:

```ts
{
  firstName: string,
  lastName: string,
  phoneNumbers: string[],
  emails: string[],
  tags: string[],
  note: string,
  id?: string | null,   // ignored on create; assigned by the adapter
}
```

The `update` command takes any subset of the above (excluding `id`). Anything
else in the JSON is rejected with a schema error.

Ids are strings throughout. The default (file) adapter assigns a
`crypto.randomUUID()` on create; the Mongo adapter assigns an ObjectId hex
string. Both render identically and the CLI never has to care which is which.

## Adapters

The CLI talks to a `DBService` port (see `services/db/port.ts`). Two
implementations ship with the project; the default wiring in `services/index.ts`
uses the file adapter. To switch, change which layer is exported from
`services/index.ts` (or compose the layer manually in your own entry point).

### File adapter (`LowDBAdapter.ts`)

Backed by a single JSON file on disk. No network, no dependencies beyond
`lowdb`. The default.

- Env: `DB_FILE_LOCATION` (path to the JSON file). The file is auto-seeded with
  `{ contacts: [] }` on first read.
- Permission flags: `--allow-read=<file>`, `--allow-write=<file>`.

### MongoDB adapter (`MongoDBAdapter.ts`)

Backed by a MongoDB collection. Connection is opened on layer construction and
closed on layer disposal (so tests and one-shot CLI runs leak no sockets).

- Env:
  - `MONGO_URI` (required) — e.g. `mongodb://localhost:27017`
  - `MONGO_DB` (optional, default `"rolodex"`)
  - `MONGO_COLLECTION` (optional, default `"contacts"`)
- Permission flags: `--allow-net=<mongo-host>` (or `--allow-net` for
  development). The driver also probes the OS release string on connect, so
  `--allow-sys=osRelease` is required too. `--allow-env` stays required for the
  `MONGO_*` vars.
- Storage model: one document per contact, with Mongo's `_id` as the internal
  identifier and the public `PersonShape.id` derived from its hex string. No
  `id` field is persisted on the document — it's always re-derived from `_id` on
  read, which avoids the "is this the doc's id or the public id?" ambiguity.
- Query semantics: `--name` and `--tag` use case-insensitive regex substring
  matches (matches the file adapter's behavior). `--id` must be a valid 24-char
  ObjectId hex; anything else returns "no contact".
- Update: `update` uses `findOneAndUpdate` with `$set` over the patch fields;
  the patch's `id` is dropped before the call (the row is anchored by the
  command-line id).

To wire the Mongo adapter, replace the `ServiceLayerLive` in
`services/index.ts`:

```ts
import { Layer } from "effect";
import { MongoDBServiceLive } from "./db/MongoDBAdapter.ts";

export const ServiceLayerLive = Layer.provide(MongoDBServiceLive);
```

and broaden the `rolodex` task's `--allow-net` flags in `deno.json` to include
your Mongo host. Run with:

```bash
MONGO_URI="mongodb://localhost:27017" deno task rolodex search --name ada
```

## Configuration

The rolodex task is defined in `deno.json`. Its permission flags are
intentionally narrow:

```
--sloppy-imports
--allow-env
--allow-read='./data.json'
--allow-write='./data.json'
--env-file=.env
```

This means the CLI can only read the env file, read and write the configured
database file, and nothing else. To point at a different database, edit `.env` —
do not change the permission flags.

## Development

```bash
deno fmt --check
deno lint
deno task test         # the rolodex project's test task; needs --allow-read/--allow-write/--allow-run
deno check --sloppy-imports main.ts main_test.ts services/
```

`deno task test` runs the suite with the permissions it actually needs (the test
runner needs `--allow-write` for `Deno.makeTempDir`; the spawned subprocesses
are still scoped per the `rolodex` task flags). Tests spawn `main.ts` as a
subprocess against a temp database so the real permission posture is exercised.
The suite covers the full CLI surface — help, every search mode, create, update,
every usage-error path, schema validation, and the auto-seed behavior on an
empty or invalid database file.

## Project layout

```
deno.json                 Tasks, import map, lint config
.env                      DB_FILE_LOCATION (file adapter) or MONGO_URI (mongo)
data.json                 The database (file adapter; auto-seeded)
main.ts                   CLI entry point — calls runCLI(Deno.args)
main_test.ts              CLI test suite (deno task test)
services/
  cli.ts                  Argument parsing, rendering, error handling
  index.ts                Re-exports the live service layer (default: file)
  db/
    port.ts               DBService tag + port interface
    LowDBAdapter.ts       file-backed implementation (default)
    LowDBAdapter_test.ts  in-process adapter tests (searchContacts)
    MongoDBAdapter.ts     MongoDB-backed implementation
schemas/
  DataBase.ts             { contacts: PersonShape[] } (file adapter only)
  Person/index.ts         PersonSchema + PersonPatchSchema (effect) + types
```
