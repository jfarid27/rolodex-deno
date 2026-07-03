// Adapter-level tests for the file-backed DBService.
//
// The CLI test suite (main_test.ts) exercises the full process and perms
// path. These tests construct the layer in-process so we can call methods
// directly, without spawning `main.ts`. For now they cover searchContacts —
// the cross-field search added to the port — to confirm the adapter's
// semantics. The Mongo adapter skips this suite per the project's
// no-running-mongo policy.

import { assert, assertEquals } from "@std/assert";
import { Effect, Layer, ManagedRuntime } from "effect";
import { makeLowDBService } from "./LowDBAdapter.ts";
import { DBService, PersonInput, PersonShape } from "./port.ts";

const withTempLayer = async (
  fn: (
    runtime: ManagedRuntime.ManagedRuntime<DBService, unknown>,
  ) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "rolodex-adapter-test-" });
  const dbFile = `${dir}/data.json`;
  // makeLowDBService binds the path directly, bypassing the global
  // ConfigProvider (Layer.setConfigProvider mutates global state, which
  // races across parallel tests).
  const layer = makeLowDBService(dbFile);
  const runtime = ManagedRuntime.make(layer as Layer.Layer<DBService, never>);
  try {
    await fn(runtime);
  } finally {
    await runtime.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
};

const make = (
  firstName: string,
  lastName: string,
  tags: string[],
  note: string,
): PersonInput => ({
  firstName,
  lastName,
  phoneNumbers: [],
  emails: [],
  tags,
  note,
  id: null,
});

const seed = (
  contacts: PersonInput[],
) =>
  Effect.gen(function* () {
    const db = yield* DBService;
    for (const c of contacts) {
      yield* db.saveContact(c);
    }
  });

// Run a search and return the inner PersonShape[]. Throws if the option is
// None — searchContacts always wraps in Some (with an empty array on no
// matches), so None would be a real bug.
const search = async (
  runtime: ManagedRuntime.ManagedRuntime<DBService, unknown>,
  query: string,
): Promise<PersonShape[]> => {
  const program = Effect.gen(function* () {
    const db = yield* DBService;
    return yield* db.searchContacts(query);
  });
  const result = await runtime.runPromise(program);
  if (result._tag !== "Some") {
    throw new Error(`expected Some(...), got ${result._tag}`);
  }
  return result.value;
};

Deno.test("searchContacts returns an empty array when nothing matches", async () => {
  await withTempLayer(async (runtime) => {
    await runtime.runPromise(
      seed([make("Ada", "Lovelace", ["math"], "first programmer")]),
    );
    const results = await search(runtime, "ghost");
    assertEquals(results.length, 0);
  });
});

Deno.test("searchContacts matches by firstName", async () => {
  await withTempLayer(async (runtime) => {
    await runtime.runPromise(
      seed([
        make("Ada", "Lovelace", ["math"], "first programmer"),
        make("Grace", "Hopper", ["navy"], "compiler"),
      ]),
    );
    const results = await search(runtime, "ada");
    assertEquals(results.length, 1);
    assertEquals(results[0].firstName, "Ada");
  });
});

Deno.test("searchContacts matches by lastName", async () => {
  await withTempLayer(async (runtime) => {
    await runtime.runPromise(
      seed([
        make("Ada", "Lovelace", ["math"], "first programmer"),
        make("Grace", "Hopper", ["navy"], "compiler"),
      ]),
    );
    const results = await search(runtime, "hopper");
    assertEquals(results.length, 1);
    assertEquals(results[0].lastName, "Hopper");
  });
});

Deno.test("searchContacts matches by tag", async () => {
  await withTempLayer(async (runtime) => {
    await runtime.runPromise(
      seed([
        make("Ada", "Lovelace", ["math", "computing"], "first programmer"),
        make("Grace", "Hopper", ["navy"], "compiler"),
      ]),
    );
    const results = await search(runtime, "navy");
    assertEquals(results.length, 1);
    assertEquals(results[0].firstName, "Grace");
  });
});

Deno.test("searchContacts matches by note (the 'description' field)", async () => {
  await withTempLayer(async (runtime) => {
    await runtime.runPromise(
      seed([
        make("Ada", "Lovelace", ["math"], "first programmer"),
        make("Grace", "Hopper", ["navy"], "compiler inventor"),
      ]),
    );
    // "programmer" only appears in Ada's note.
    const programmer = await search(runtime, "programmer");
    assertEquals(programmer.length, 1);
    assertEquals(programmer[0].firstName, "Ada");

    // "compiler" only appears in Grace's note.
    const compiler = await search(runtime, "compiler");
    assertEquals(compiler.length, 1);
    assertEquals(compiler[0].firstName, "Grace");
  });
});

Deno.test("searchContacts returns every contact that matches any field", async () => {
  await withTempLayer(async (runtime) => {
    await runtime.runPromise(
      seed([
        // matches by firstName
        make("Ada", "Lovelace", ["math"], "first programmer"),
        // matches by tag
        make("Grace", "Hopper", ["navy"], "compiler"),
        // matches by note
        make("Alan", "Turing", ["cs"], "enigma codebreaker"),
        // doesn't match anything
        make("Marie", "Curie", ["science"], "radioactivity"),
      ]),
    );
    // "math" only matches Ada's tag.
    const mathResults = await search(runtime, "math");
    assertEquals(mathResults.length, 1);
    assertEquals(mathResults[0].firstName, "Ada");

    // "codebreaker" only in Alan's note.
    const codebreakerResults = await search(runtime, "codebreaker");
    assertEquals(codebreakerResults.length, 1);
    assertEquals(codebreakerResults[0].firstName, "Alan");
  });
});

Deno.test("searchContacts is case-insensitive", async () => {
  await withTempLayer(async (runtime) => {
    await runtime.runPromise(
      seed([
        make("Ada", "Lovelace", ["Math"], "First Programmer"),
      ]),
    );
    const upper = await search(runtime, "MATH");
    assertEquals(upper.length, 1);

    const lower = await search(runtime, "math");
    assertEquals(lower.length, 1);

    const mixed = await search(runtime, "MaTh");
    assertEquals(mixed.length, 1);
  });
});

Deno.test("searchContacts dedupes a contact that matches on multiple fields", async () => {
  await withTempLayer(async (runtime) => {
    // Query appears in BOTH firstName and note — should still be returned
    // exactly once.
    await runtime.runPromise(
      seed([
        make("Algorithmic", "X", ["z"], "algorithmic note"),
      ]),
    );
    const results = await search(runtime, "algorithmic");
    assertEquals(results.length, 1);
  });
});

Deno.test("searchContacts substring is non-anchored", async () => {
  await withTempLayer(async (runtime) => {
    await runtime.runPromise(
      seed([
        make("Robert", "Smith", ["x"], "alpha beta gamma"),
      ]),
    );
    // middle-of-word match should hit (same semantics as getContactsByName).
    const results = await search(runtime, "lph");
    assertEquals(results.length, 1);
  });
});

Deno.test("searchContacts with empty string matches every contact", async () => {
  await withTempLayer(async (runtime) => {
    await runtime.runPromise(
      seed([
        make("Ada", "Lovelace", ["math"], "x"),
        make("Grace", "Hopper", ["navy"], "y"),
      ]),
    );
    // Empty string is contained in every string, so this returns everything.
    // (Consistent with --name / --tag behavior.)
    const results = await search(runtime, "");
    assertEquals(results.length, 2);
  });
});

// Date-stamping tests for saveContact and updateContact. These run
// in-process against the file adapter's layer and check the in-memory
// PersonShape directly (the CLI test suite checks the on-disk shape).
const saveOne = (
  runtime: ManagedRuntime.ManagedRuntime<DBService, unknown>,
  contact: PersonInput,
): Promise<PersonShape> => {
  const program = Effect.gen(function* () {
    const db = yield* DBService;
    return yield* db.saveContact(contact);
  });
  return runtime.runPromise(program);
};

const updateOne = (
  runtime: ManagedRuntime.ManagedRuntime<DBService, unknown>,
  id: string,
  patch: Partial<PersonShape>,
): Promise<PersonShape> => {
  const program = Effect.gen(function* () {
    const db = yield* DBService;
    return yield* db.updateContact(id, patch);
  });
  return runtime.runPromise(program);
};

Deno.test(
  "saveContact stamps createdAt and updatedAt with Date instances",
  async () => {
    await withTempLayer(async (runtime) => {
      const before = Date.now();
      const saved = await saveOne(runtime, make("Ada", "Lovelace", ["x"], ""));
      const after = Date.now();
      assert(saved.createdAt instanceof Date);
      assert(saved.updatedAt instanceof Date);
      assert(
        saved.createdAt.getTime() >= before - 10 &&
          saved.createdAt.getTime() <= after + 10,
      );
      assert(
        saved.updatedAt.getTime() >= before - 10 &&
          saved.updatedAt.getTime() <= after + 10,
      );
    });
  },
);

Deno.test(
  "saveContact sets createdAt and updatedAt to the same instant",
  async () => {
    await withTempLayer(async (runtime) => {
      const saved = await saveOne(runtime, make("Ada", "Lovelace", ["x"], ""));
      assertEquals(
        saved.createdAt.getTime(),
        saved.updatedAt.getTime(),
        "create should stamp both timestamps in the same instant",
      );
    });
  },
);

Deno.test(
  "saveContact with an explicit id preserves id and stamps timestamps",
  async () => {
    await withTempLayer(async (runtime) => {
      const c: PersonInput = {
        ...make("Ada", "Lovelace", ["x"], ""),
        id: "explicit-id",
      };
      const saved = await saveOne(runtime, c);
      assertEquals(saved.id, "explicit-id");
      assert(saved.createdAt instanceof Date);
      assert(saved.updatedAt instanceof Date);
    });
  },
);

Deno.test(
  "updateContact preserves createdAt and bumps updatedAt",
  async () => {
    await withTempLayer(async (runtime) => {
      const saved = await saveOne(
        runtime,
        make("Ada", "Lovelace", ["x"], "v0"),
      );
      const originalCreatedAt = saved.createdAt;
      // Sleep a few ms so updatedAt advances measurably.
      await new Promise((r) => setTimeout(r, 5));
      const updated = await updateOne(runtime, saved.id!, {
        note: "v1",
      });
      assertEquals(updated.createdAt.getTime(), originalCreatedAt.getTime());
      assert(updated.updatedAt.getTime() > originalCreatedAt.getTime());
      assertEquals(updated.note, "v1");
    });
  },
);

Deno.test(
  "updateContact strips createdAt/updatedAt from the patch (defensive)",
  async () => {
    // The port's `PersonInput` type doesn't include the timestamp
    // fields, but a programmatic caller could still pass a wider type.
    // The adapter must ignore the patch's timestamps and let the
    // adapter-managed values win. We widen the patch to a structural
    // type that explicitly includes the forbidden fields, then cast
    // at the call site.
    await withTempLayer(async (runtime) => {
      const saved = await saveOne(
        runtime,
        make("Ada", "Lovelace", ["x"], "v0"),
      );
      const fakeCreatedAt = new Date("2000-01-01T00:00:00.000Z");
      const fakeUpdatedAt = new Date("1999-01-01T00:00:00.000Z");
      // Sleep so the adapter's "now" for updatedAt is strictly later
      // than the saved createdAt at ms resolution.
      await new Promise((r) => setTimeout(r, 5));
      type SneakyPatch = Partial<PersonShape> & {
        createdAt: Date;
        updatedAt: Date;
      };
      const sneakyPatch: SneakyPatch = {
        note: "v1",
        createdAt: fakeCreatedAt,
        updatedAt: fakeUpdatedAt,
      };
      const updated = await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* DBService;
          // The port's updateContact accepts `Partial<PersonShape>`,
          // which is structurally compatible with our SneakyPatch
          // (extra fields are allowed at the type level for spreads
          // and patches; the adapter drops them at runtime).
          return yield* db.updateContact(
            saved.id!,
            // deno-lint-ignore no-explicit-any
            sneakyPatch as any,
          );
        }),
      );
      assertEquals(
        updated.createdAt.getTime(),
        saved.createdAt.getTime(),
        "patch's createdAt must be ignored",
      );
      assert(
        updated.updatedAt.getTime() > saved.createdAt.getTime(),
        `updatedAt should advance to 'now', not the patch's stale value ` +
          `(saved.createdAt=${saved.createdAt.toISOString()}, ` +
          `updated.updatedAt=${updated.updatedAt.toISOString()})`,
      );
    });
  },
);

Deno.test(
  "persistence: file stores ISO strings; in-memory is Date instances",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "rolodex-persist-test-" });
    const dbFile = `${dir}/data.json`;
    const layer = makeLowDBService(dbFile);
    const runtime = ManagedRuntime.make(layer as Layer.Layer<DBService, never>);
    try {
      const saved = await saveOne(runtime, make("Ada", "Lovelace", ["x"], ""));
      // The on-disk file is JSON; Date instances are serialized to ISO
      // strings by JSON.stringify.
      const onDisk = JSON.parse(await Deno.readTextFile(dbFile)) as {
        contacts: Array<{ createdAt: string; updatedAt: string }>;
      };
      assertEquals(typeof onDisk.contacts[0].createdAt, "string");
      assertEquals(typeof onDisk.contacts[0].updatedAt, "string");
      assertEquals(
        onDisk.contacts[0].createdAt,
        saved.createdAt.toISOString(),
      );
      assertEquals(
        onDisk.contacts[0].updatedAt,
        saved.updatedAt.toISOString(),
      );
    } finally {
      await runtime.dispose();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "round-trip: read converts ISO strings back to Date instances",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "rolodex-roundtrip-test-" });
    const dbFile = `${dir}/data.json`;
    // First runtime: create a contact, then dispose.
    {
      const layer = makeLowDBService(dbFile);
      const runtime = ManagedRuntime.make(
        layer as Layer.Layer<DBService, never>,
      );
      await saveOne(runtime, make("Ada", "Lovelace", ["x"], ""));
      await runtime.dispose();
    }
    // Second runtime: re-open the same file and verify the timestamps
    // come back as Date instances, not strings.
    {
      const layer = makeLowDBService(dbFile);
      const runtime = ManagedRuntime.make(
        layer as Layer.Layer<DBService, never>,
      );
      try {
        const results = await search(runtime, "ada");
        assertEquals(results.length, 1);
        assert(results[0].createdAt instanceof Date);
        assert(results[0].updatedAt instanceof Date);
        assert(!Number.isNaN(results[0].createdAt.getTime()));
        assert(!Number.isNaN(results[0].updatedAt.getTime()));
      } finally {
        await runtime.dispose();
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    }
  },
);

Deno.test(
  "backfill: legacy data without timestamps is read as the epoch",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "rolodex-legacy-test-" });
    const dbFile = `${dir}/data.json`;
    // Write a pre-feature record: no createdAt, no updatedAt.
    await Deno.writeTextFile(
      dbFile,
      JSON.stringify({
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
      }),
    );
    const layer = makeLowDBService(dbFile);
    const runtime = ManagedRuntime.make(layer as Layer.Layer<DBService, never>);
    try {
      const results = await search(runtime, "legacy");
      assertEquals(results.length, 1);
      assert(results[0].createdAt instanceof Date);
      assert(results[0].updatedAt instanceof Date);
      assertEquals(
        results[0].createdAt.getTime(),
        0,
        "missing createdAt should be backfilled with the epoch",
      );
      assertEquals(
        results[0].updatedAt.getTime(),
        0,
        "missing updatedAt should be backfilled with the epoch",
      );
    } finally {
      await runtime.dispose();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);
