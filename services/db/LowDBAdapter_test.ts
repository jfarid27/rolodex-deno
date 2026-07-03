// Adapter-level tests for the file-backed DBService.
//
// The CLI test suite (main_test.ts) exercises the full process and perms
// path. These tests construct the layer in-process so we can call methods
// directly, without spawning `main.ts`. For now they cover searchContacts —
// the cross-field search added to the port — to confirm the adapter's
// semantics. The Mongo adapter skips this suite per the project's
// no-running-mongo policy.

import { assertEquals } from "@std/assert";
import { Effect, Layer, ManagedRuntime } from "effect";
import { makeLowDBService } from "./LowDBAdapter.ts";
import { DBService } from "./port.ts";
import { PersonShape } from "../../schemas/Person/index.ts";

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
): Omit<PersonShape, "id"> => ({
  firstName,
  lastName,
  phoneNumbers: [],
  emails: [],
  tags,
  note,
});

const seed = (
  contacts: Omit<PersonShape, "id">[],
) =>
  Effect.gen(function* () {
    const db = yield* DBService;
    for (const c of contacts) {
      yield* db.saveContact({ ...c, id: null });
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
