// Tests for the rolodex CLI. Each test spawns `main.ts` as a subprocess so
// the real permission flow is exercised, and uses a fresh temp DB.
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { PersonShape } from "./schemas/Person/index.ts";

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

const runCli = async (
  args: string[],
  dbFile: string,
): Promise<CliResult> => {
  // Mirrors the production `rolodex` task: scoped read/write to one DB file.
  // We pass DB_FILE_LOCATION via the subprocess env (the task uses
  // `--env-file`; for tests we set it directly to avoid an extra .env file).
  // `--allow-env` is required so the CLI's `Deno.env.get("DB_FILE_LOCATION")`
  // can read it.
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--sloppy-imports",
      "--allow-env",
      `--allow-read=${dbFile}`,
      `--allow-write=${dbFile}`,
      "./main.ts",
      ...args,
    ],
    env: { DB_FILE_LOCATION: dbFile },
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
  };
};

const withTempDb = async (
  fn: (dbFile: string) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "rolodex-test-" });
  const dbFile = `${dir}/data.json`;
  try {
    await fn(dbFile);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
};

Deno.test("help prints usage", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["help"], db);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "USAGE:");
    assertStringIncludes(r.stdout, "search --name");
    assertStringIncludes(r.stdout, "search --id");
    assertStringIncludes(r.stdout, "search --tag");
    assertStringIncludes(r.stdout, "create <contact-json>");
  });
});

Deno.test("no args defaults to help", async () => {
  await withTempDb(async (db) => {
    const r = await runCli([], db);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "USAGE:");
  });
});

Deno.test("create + search by name", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: ["+44-0"],
      emails: ["ada@example.com"],
      tags: ["math", "computing"],
      note: "first programmer",
    });
    const createR = await runCli(["create", ada], db);
    assertEquals(createR.code, 0, `stderr: ${createR.stderr}`);
    assertStringIncludes(createR.stdout, "Ada Lovelace");

    const searchR = await runCli(["search", "--name", "ada"], db);
    assertEquals(searchR.code, 0);
    assertStringIncludes(searchR.stdout, "Ada Lovelace");
    assert(!searchR.stdout.includes("Grace Hopper"));
  });
});

Deno.test("create + search by tag (substring)", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: [],
      emails: [],
      tags: ["math", "computing"],
      note: "",
    });
    const grace = JSON.stringify({
      firstName: "Grace",
      lastName: "Hopper",
      phoneNumbers: [],
      emails: [],
      tags: ["navy", "computing"],
      note: "",
    });
    assertEquals((await runCli(["create", ada], db)).code, 0);
    assertEquals((await runCli(["create", grace], db)).code, 0);

    const r = await runCli(["search", "--tag", "comp"], db);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "2 contact(s)");
    assertStringIncludes(r.stdout, "Ada");
    assertStringIncludes(r.stdout, "Grace");
  });
});

Deno.test("create + search by id (hit and miss)", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: [],
      emails: [],
      tags: [],
      note: "",
    });
    const createR = await runCli(["create", ada], db);
    assertEquals(createR.code, 0);

    const onDisk = JSON.parse(await Deno.readTextFile(db)) as {
      contacts: PersonShape[];
    };
    const adaId = onDisk.contacts[0].id;
    assertExists(adaId);

    const hitR = await runCli(["search", "--id", String(adaId)], db);
    assertEquals(hitR.code, 0);
    assertStringIncludes(hitR.stdout, "Ada Lovelace");

    const missR = await runCli(["search", "--id", "99999"], db);
    assertEquals(missR.code, 0);
    assertStringIncludes(missR.stdout, "no contact");
  });
});

Deno.test("create auto-assigns a string id and persists", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: [],
      emails: [],
      tags: [],
      note: "",
    });
    const r = await runCli(["create", ada], db);
    assertEquals(r.code, 0);

    const onDisk = JSON.parse(await Deno.readTextFile(db)) as {
      contacts: PersonShape[];
    };
    assertEquals(onDisk.contacts.length, 1);
    // The lowdb adapter uses crypto.randomUUID(); the Mongo adapter uses
    // ObjectId hex. Both are strings, so this assertion is the shared contract.
    assertEquals(typeof onDisk.contacts[0].id, "string");
    assert((onDisk.contacts[0].id as string).length > 0);
  });
});

Deno.test("empty/invalid db is auto-seeded with the default", async () => {
  await withTempDb(async (db) => {
    // Create a DB file with garbage in it.
    await Deno.writeTextFile(db, "not json at all");
    const r = await runCli(["help"], db);
    assertEquals(r.code, 0);
    const onDisk = JSON.parse(await Deno.readTextFile(db));
    assertEquals(onDisk.contacts, []);
  });
});

Deno.test("invalid JSON returns exit 1 with friendly error", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["create", "not json"], db);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stderr, "error:");
    assertStringIncludes(r.stderr.toLowerCase(), "json");
  });
});

Deno.test("schema-invalid contact returns exit 1 with schema error", async () => {
  await withTempDb(async (db) => {
    // Missing required field `firstName`.
    const bad = JSON.stringify({
      lastName: "X",
      phoneNumbers: [],
      emails: [],
      tags: [],
      note: "",
    });
    const r = await runCli(["create", bad], db);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stderr.toLowerCase(), "schema");
  });
});

Deno.test("search with no flag returns usage error (exit 2)", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["search"], db);
    assertEquals(r.code, 2);
    assertStringIncludes(r.stderr, "requires one of");
  });
});

Deno.test("search with two flags returns exclusivity error (exit 2)", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["search", "--name", "x", "--tag", "y"], db);
    assertEquals(r.code, 2);
    assertStringIncludes(r.stderr, "exactly one");
  });
});

Deno.test("create with no arg returns usage error (exit 2)", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["create"], db);
    assertEquals(r.code, 2);
    assertStringIncludes(r.stderr, "exactly one");
  });
});

Deno.test("unknown subcommand returns usage error (exit 2)", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["bogus"], db);
    assertEquals(r.code, 2);
    assertStringIncludes(r.stderr, "unknown subcommand");
  });
});

Deno.test("search by id with unknown id prints no-match (exit 0)", async () => {
  await withTempDb(async (db) => {
    // Ids are strings now (UUIDs from the lowdb adapter, ObjectId hex from
    // the Mongo adapter). The adapter returns None for unknown ids, so this
    // is a clean exit 0 with a friendly "no contact" message.
    const r = await runCli(["search", "--id", "definitely-not-a-real-id"], db);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "no contact");
  });
});

Deno.test("update + verify by id shows new values", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: ["+44-0"],
      emails: ["ada@example.com"],
      tags: ["math"],
      note: "first programmer",
    });
    assertEquals((await runCli(["create", ada], db)).code, 0);

    const onDisk = JSON.parse(await Deno.readTextFile(db)) as {
      contacts: PersonShape[];
    };
    const adaId = onDisk.contacts[0].id;
    assertExists(adaId);

    // Patch only the note and tags; everything else should be preserved.
    const patch = JSON.stringify({
      note: "analytical engine",
      tags: ["math", "computing", "history"],
    });
    const updateR = await runCli(
      ["update", String(adaId), patch],
      db,
    );
    assertEquals(updateR.code, 0, `stderr: ${updateR.stderr}`);
    assertStringIncludes(updateR.stdout, "updated:");
    assertStringIncludes(updateR.stdout, "analytical engine");
    assertStringIncludes(updateR.stdout, "computing");

    // Search by id to confirm the change was persisted.
    const searchR = await runCli(["search", "--id", String(adaId)], db);
    assertEquals(searchR.code, 0);
    assertStringIncludes(searchR.stdout, "analytical engine");
    assertStringIncludes(searchR.stdout, "computing");
    // Untouched fields still present.
    assertStringIncludes(searchR.stdout, "Ada Lovelace");
    assertStringIncludes(searchR.stdout, "+44-0");
    assertStringIncludes(searchR.stdout, "ada@example.com");
  });
});

Deno.test("update preserves the original id (patch id is ignored)", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: [],
      emails: [],
      tags: [],
      note: "",
    });
    assertEquals((await runCli(["create", ada], db)).code, 0);

    const before = JSON.parse(await Deno.readTextFile(db)) as {
      contacts: PersonShape[];
    };
    const originalId = before.contacts[0].id;
    assertExists(originalId);

    // Try to change the id via the patch. The CLI should still match the row
    // by the command-line id and ignore the patch's id. (The patch's id is
    // accepted for type-compatibility but is always ignored by the adapter.)
    const patch = JSON.stringify({
      id: "totally-different-id",
      firstName: "Augusta",
    });
    const updateR = await runCli(
      ["update", String(originalId), patch],
      db,
    );
    assertEquals(updateR.code, 0, `stderr: ${updateR.stderr}`);

    const after = JSON.parse(await Deno.readTextFile(db)) as {
      contacts: PersonShape[];
    };
    assertEquals(after.contacts.length, 1);
    assertEquals(after.contacts[0].id, originalId);
    assertEquals(after.contacts[0].firstName, "Augusta");
  });
});

Deno.test("update with unknown id returns exit 1 with friendly error", async () => {
  await withTempDb(async (db) => {
    // Need an id that won't be generated by the lowdb adapter (which uses
    // crypto.randomUUID — collision essentially impossible) and is also not a
    // valid 24-char ObjectId hex, so it can't match a Mongo row either. The
    // adapter's "no contact" path produces a clean exit 1.
    const patch = JSON.stringify({ note: "ghost" });
    const r = await runCli(
      ["update", "not-a-real-id", patch],
      db,
    );
    assertEquals(r.code, 1);
    assertStringIncludes(r.stderr.toLowerCase(), "no contact with id");
  });
});

Deno.test("update with wrong arg count returns exit 2", async () => {
  await withTempDb(async (db) => {
    // No json arg.
    const noJson = await runCli(["update", "1"], db);
    assertEquals(noJson.code, 2);
    assertStringIncludes(noJson.stderr, "exactly two");

    // No args at all.
    const noArgs = await runCli(["update"], db);
    assertEquals(noArgs.code, 2);
    assertStringIncludes(noArgs.stderr, "exactly two");

    // Too many args.
    const tooMany = await runCli(
      ["update", "1", "{}", "{}"],
      db,
    );
    assertEquals(tooMany.code, 2);
    assertStringIncludes(tooMany.stderr, "exactly two");
  });
});

Deno.test("update with invalid JSON returns exit 1", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["update", "1", "not json"], db);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stderr.toLowerCase(), "json");
  });
});

Deno.test("update with schema-invalid JSON returns exit 1", async () => {
  await withTempDb(async (db) => {
    // `tags` is present but the wrong type (number instead of string[]).
    const bad = JSON.stringify({
      tags: 42,
    });
    const r = await runCli(["update", "1", bad], db);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stderr.toLowerCase(), "schema");
  });
});

Deno.test("update with empty JSON object is a no-op (still succeeds)", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: [],
      emails: [],
      tags: [],
      note: "",
    });
    assertEquals((await runCli(["create", ada], db)).code, 0);
    const onDisk = JSON.parse(await Deno.readTextFile(db)) as {
      contacts: PersonShape[];
    };
    const adaId = onDisk.contacts[0].id;

    // Empty patch should be valid and just re-render the existing record.
    const r = await runCli(["update", String(adaId), "{}"], db);
    assertEquals(r.code, 0, `stderr: ${r.stderr}`);
    assertStringIncludes(r.stdout, "Ada Lovelace");
  });
});

Deno.test("help text mentions update subcommand", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["help"], db);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "update <id>");
  });
});

Deno.test("help text mentions stats subcommand", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["help"], db);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "rolodex stats");
  });
});

Deno.test("stats on an empty database returns contacts: 0", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["stats"], db);
    assertEquals(r.code, 0, `stderr: ${r.stderr}`);
    // The CLI prints the stats object as pretty-printed JSON. Parse it back
    // so we're testing the structured contract, not the formatting.
    const stats = JSON.parse(r.stdout) as {
      counts: { contacts: number };
    };
    assertEquals(stats.counts.contacts, 0);
  });
});

Deno.test("stats reflects the current contact count", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: [],
      emails: [],
      tags: [],
      note: "",
    });
    const grace = JSON.stringify({
      firstName: "Grace",
      lastName: "Hopper",
      phoneNumbers: [],
      emails: [],
      tags: [],
      note: "",
    });
    assertEquals((await runCli(["create", ada], db)).code, 0);
    assertEquals((await runCli(["create", grace], db)).code, 0);

    const r = await runCli(["stats"], db);
    assertEquals(r.code, 0, `stderr: ${r.stderr}`);
    const stats = JSON.parse(r.stdout) as {
      counts: { contacts: number };
    };
    assertEquals(stats.counts.contacts, 2);
  });
});

Deno.test("stats count decrements after... actually, only create exists", async () => {
  // There's no delete subcommand yet, so the only way to reduce the count
  // is to seed with a non-empty file and assert the adapter reads it
  // through.
  await withTempDb(async (db) => {
    // Seed with three contacts before the CLI ever runs.
    await Deno.writeTextFile(
      db,
      JSON.stringify({
        contacts: [
          {
            id: "a",
            firstName: "A",
            lastName: "A",
            phoneNumbers: [],
            emails: [],
            tags: [],
            note: "",
            createdAt: "1970-01-01T00:00:00.000Z",
            updatedAt: "1970-01-01T00:00:00.000Z",
          },
          {
            id: "b",
            firstName: "B",
            lastName: "B",
            phoneNumbers: [],
            emails: [],
            tags: [],
            note: "",
            createdAt: "1970-01-01T00:00:00.000Z",
            updatedAt: "1970-01-01T00:00:00.000Z",
          },
          {
            id: "c",
            firstName: "C",
            lastName: "C",
            phoneNumbers: [],
            emails: [],
            tags: [],
            note: "",
            createdAt: "1970-01-01T00:00:00.000Z",
            updatedAt: "1970-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const r = await runCli(["stats"], db);
    assertEquals(r.code, 0, `stderr: ${r.stderr}`);
    const stats = JSON.parse(r.stdout) as {
      counts: { contacts: number };
    };
    assertEquals(stats.counts.contacts, 3);
  });
});

Deno.test("stats with extra args returns usage error (exit 2)", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["stats", "extra"], db);
    assertEquals(r.code, 2);
    assertStringIncludes(r.stderr, "no arguments");
  });
});

Deno.test("help text mentions update subcommand", async () => {
  await withTempDb(async (db) => {
    const r = await runCli(["help"], db);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "update <id>");
  });
});

// On-disk representation of a contact. Mirrors the file-adapter's storage
// format: timestamps are ISO strings, not Date instances. We type it
// loosely to keep the test focused on the timestamp fields' shape rather
// than the rest of the contact.
interface OnDiskContact {
  id: string;
  firstName: string;
  lastName: string;
  createdAt: string;
  updatedAt: string;
}

Deno.test("create stamps createdAt and updatedAt to roughly the same time", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: [],
      emails: [],
      tags: [],
      note: "",
    });
    const before = Date.now();
    const r = await runCli(["create", ada], db);
    assertEquals(r.code, 0, `stderr: ${r.stderr}`);
    const after = Date.now();

    const onDisk = JSON.parse(await Deno.readTextFile(db)) as {
      contacts: OnDiskContact[];
    };
    assertEquals(onDisk.contacts.length, 1);
    const c = onDisk.contacts[0];

    // createdAt and updatedAt should be valid ISO timestamps, both
    // stamped during the create call.
    const createdMs = new Date(c.createdAt).getTime();
    const updatedMs = new Date(c.updatedAt).getTime();
    assert(!Number.isNaN(createdMs), "createdAt should be a valid date");
    assert(!Number.isNaN(updatedMs), "updatedAt should be a valid date");
    // Allow a 10ms window on either side for clock jitter; the create
    // call should always stamp them in the same instant.
    assert(
      createdMs >= before - 10 && createdMs <= after + 10,
      `createdAt ${c.createdAt} out of expected window [${before}, ${after}]`,
    );
    assert(
      updatedMs >= before - 10 && updatedMs <= after + 10,
      `updatedAt ${c.updatedAt} out of expected window [${before}, ${after}]`,
    );
  });
});

Deno.test("create renders the timestamps in the CLI output", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: [],
      emails: [],
      tags: [],
      note: "",
    });
    const r = await runCli(["create", ada], db);
    assertEquals(r.code, 0, `stderr: ${r.stderr}`);
    // The renderer should expose the two timestamps. We don't assert the
    // exact format — just that the lines and the date values are present.
    assertStringIncludes(r.stdout, "created:");
    assertStringIncludes(r.stdout, "updated:");
    // The date is rendered as an ISO string; the regex matches the "Z"
    // suffix that Date.prototype.toISOString() always emits.
    assert(
      /created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(
        r.stdout,
      ),
      `expected an ISO timestamp in the created line; got:\n${r.stdout}`,
    );
    assert(
      /updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(
        r.stdout,
      ),
      `expected an ISO timestamp in the updated line; got:\n${r.stdout}`,
    );
  });
});

Deno.test("update preserves createdAt and bumps updatedAt", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: [],
      emails: [],
      tags: [],
      note: "",
    });
    assertEquals((await runCli(["create", ada], db)).code, 0);

    const beforeUpdate = JSON.parse(await Deno.readTextFile(db)) as {
      contacts: OnDiskContact[];
    };
    const originalCreatedAt = beforeUpdate.contacts[0].createdAt;
    const originalUpdatedAt = beforeUpdate.contacts[0].updatedAt;
    const adaId = beforeUpdate.contacts[0].id;

    // Sleep a few ms so the updatedAt is guaranteed to be later than
    // createdAt at ms resolution (timestamps are ISO strings with ms
    // precision). Effect's date is ms-granular.
    await new Promise((r) => setTimeout(r, 5));

    const patch = JSON.stringify({ note: "analytical engine" });
    const r = await runCli(["update", adaId, patch], db);
    assertEquals(r.code, 0, `stderr: ${r.stderr}`);

    const afterUpdate = JSON.parse(await Deno.readTextFile(db)) as {
      contacts: OnDiskContact[];
    };
    const c = afterUpdate.contacts[0];
    assertEquals(
      c.createdAt,
      originalCreatedAt,
      "createdAt must be preserved across an update",
    );
    assert(
      new Date(c.updatedAt).getTime() >
        new Date(originalUpdatedAt).getTime(),
      `updatedAt should advance after an update (was ${originalUpdatedAt}, now ${c.updatedAt})`,
    );
  });
});

Deno.test("a contact's updatedAt > createdAt after an update", async () => {
  await withTempDb(async (db) => {
    const ada = JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumbers: [],
      emails: [],
      tags: [],
      note: "",
    });
    assertEquals((await runCli(["create", ada], db)).code, 0);
    const before = JSON.parse(await Deno.readTextFile(db)) as {
      contacts: OnDiskContact[];
    };
    const adaId = before.contacts[0].id;

    // Tiny delay so the update's timestamp is strictly later.
    await new Promise((r) => setTimeout(r, 5));

    const patch = JSON.stringify({ note: "x" });
    assertEquals(
      (await runCli(["update", adaId, patch], db)).code,
      0,
    );
    const after = JSON.parse(await Deno.readTextFile(db)) as {
      contacts: OnDiskContact[];
    };
    const c = after.contacts[0];
    assert(
      new Date(c.updatedAt).getTime() > new Date(c.createdAt).getTime(),
      `updatedAt (${c.updatedAt}) should be strictly after createdAt (${c.createdAt})`,
    );
  });
});

Deno.test("old data files without timestamps are backfilled with the epoch", async () => {
  await withTempDb(async (db) => {
    // Hand-write a contact that predates the timestamp feature: no
    // createdAt, no updatedAt. The file adapter should backfill both
    // with the epoch sentinel (1970-01-01T00:00:00.000Z) on read.
    const legacy = {
      contacts: [
        {
          id: "legacy-id",
          firstName: "Legacy",
          lastName: "L",
          phoneNumbers: [],
          emails: [],
          tags: [],
          note: "",
        },
      ],
    };
    await Deno.writeTextFile(db, JSON.stringify(legacy));

    const r = await runCli(["search", "--id", "legacy-id"], db);
    assertEquals(r.code, 0, `stderr: ${r.stderr}`);
    // The renderer should expose the backfilled epoch for both
    // timestamps. The user sees a recognisable date rather than "Invalid
    // Date" or a crash.
    assertStringIncludes(
      r.stdout,
      "1970-01-01T00:00:00.000Z",
    );
  });
});
