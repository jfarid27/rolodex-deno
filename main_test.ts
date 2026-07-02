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
