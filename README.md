# rolodex

A small terminal-based contacts manager. One JSON file on disk, three
subcommands, no network, no server. The whole interface is `deno task rolodex`.

## Install

Requires [Deno](https://deno.com) 2.x. Clone the repo, then create a local
`.env` pointing at the database file:

```bash
git clone <repo-url> rolodex
cd rolodex
echo 'DB_FILE_LOCATION="./data.json"' > .env
touch data.json
```

The `data.json` file can be empty — the CLI seeds it on first run.

## Usage

```bash
deno task rolodex help
deno task rolodex create '{"firstName":"Ada","lastName":"Lovelace","phoneNumbers":["+44-0"],"emails":["ada@example.com"],"tags":["math","computing"],"note":"first programmer"}'
deno task rolodex search --name ada
deno task rolodex search --id   1783025641867
deno task rolodex search --tag  computing
deno task rolodex update 1783025641867 '{"note":"analytical engine","tags":["math","computing","history"]}'
```

Subcommands:

| command                      | description                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `search --name <query>`      | Case-insensitive substring match on first/last name.                                            |
| `search --id <n>`            | Exact id match.                                                                                 |
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
deno task rolodex update 1783025641867 '{"note":"analytical engine"}'

# Change multiple fields at once.
deno task rolodex update 1783025641867 '{"note":"x","tags":["a","b"]}'

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
  id?: number | null,   // ignored on create; assigned by the CLI
}
```

The `update` command takes any subset of the above (excluding `id`). Anything
else in the JSON is rejected with a schema error.

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
.env                      DB_FILE_LOCATION
data.json                 The database (auto-seeded)
main.ts                   CLI entry point — calls runCLI(Deno.args)
main_test.ts              CLI test suite (deno task test)
services/
  cli.ts                  Argument parsing, rendering, error handling
  index.ts                Re-exports the live service layer
  db/
    port.ts               DBService tag + port interface
    LowDBAdapter.ts       live implementation backed by lowdb/Low
schemas/
  DataBase.ts             { contacts: PersonShape[] }
  Person/index.ts         PersonSchema + PersonPatchSchema (effect) + types
```
