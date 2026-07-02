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
```

Subcommands:

| command                 | description                                          |
| ----------------------- | ---------------------------------------------------- |
| `search --name <query>` | Case-insensitive substring match on first/last name. |
| `search --id <n>`       | Exact id match.                                      |
| `search --tag <query>`  | Case-insensitive substring match on any tag.         |
| `create <contact-json>` | Insert a contact. Id is auto-assigned; ignore it.    |
| `help`                  | Print the full help text.                            |

Exit codes: `0` success, `1` runtime error (DB, invalid JSON, schema mismatch),
`2` usage error (bad flags, missing args, unknown subcommand).

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

Anything else in the JSON is rejected with a schema error.

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
deno test
deno check --sloppy-imports main.ts main_test.ts services/
```

Tests spawn `main.ts` as a subprocess against a temp database so the real
permission posture is exercised. The suite covers the full CLI surface — help,
every search mode, create, every usage-error path, schema validation, and the
auto-seed behavior on an empty or invalid database file.

## Project layout

```
deno.json                 Tasks, import map, lint config
.env                      DB_FILE_LOCATION
data.json                 The database (auto-seeded)
main.ts                   CLI entry point — calls runCLI(Deno.args)
main_test.ts              CLI test suite (deno test)
services/
  cli.ts                  Argument parsing, rendering, error handling
  index.ts                Re-exports the live service layer
  db/
    port.ts               DBService tag + port interface
    LowDBAdapter.ts       live implementation backed by lowdb/Low
schemas/
  DataBase.ts             { contacts: PersonShape[] }
  Person/index.ts         PersonSchema (effect) + PersonShape (type)
```
