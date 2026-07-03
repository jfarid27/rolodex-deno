// Tests for the Person schema family: PersonSchema (full in-memory record),
// PersonInputSchema (user-supplied create payload), and PersonPatchSchema
// (partial user-supplied update payload).
//
// Pattern: each test uses a `makeRawMock*` factory to build a known-good
// raw input, mutates exactly one field to make the test case, and asserts
// the decoded Either is Right (valid) or Left (rejected) as appropriate.
//
// Note on extras: by default `Schema.Struct` silently strips unknown
// properties rather than rejecting them. The PersonInputSchema and
// PersonPatchSchema therefore do NOT list `id`, `createdAt`, or
// `updatedAt` as fields — they are simply absent. If a caller supplies
// one of those fields, the schema drops it on decode. The adapter is the
// last line of defense: it never reads these fields from the decoded
// input (the port's `PersonInput` type doesn't include them).
import { assert, assertEquals } from "@std/assert";
import { Either, Schema } from "effect";
import { PersonInputSchema, PersonPatchSchema, PersonSchema } from "./index.ts";

// makeRawMockPerson builds a fully-valid raw object that should decode
// cleanly through PersonSchema. Every field has a known value, so a test
// can spread it and overwrite exactly one field to drive the failure path.
const makeRawMockPerson = () => ({
  id: "test-id-123",
  firstName: "Ada",
  lastName: "Lovelace",
  phoneNumbers: ["+44-0"],
  emails: ["ada@example.com"],
  tags: ["math", "computing"],
  note: "first programmer",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
});

const decodePerson = (raw: unknown) =>
  Schema.decodeUnknownEither(PersonSchema)(raw);

const decodeInput = (raw: unknown) =>
  Schema.decodeUnknownEither(PersonInputSchema)(raw);

const decodePatch = (raw: unknown) =>
  Schema.decodeUnknownEither(PersonPatchSchema)(raw);

Deno.test("PersonSchema decodes a fully-valid raw object", () => {
  const raw = makeRawMockPerson();
  const result = decodePerson(raw);
  assert(Either.isRight(result), "expected Right for a valid Person");
  if (Either.isRight(result)) {
    assertEquals(result.right.id, "test-id-123");
    assertEquals(result.right.firstName, "Ada");
    assertEquals(result.right.lastName, "Lovelace");
    assertEquals(result.right.phoneNumbers, ["+44-0"]);
    assertEquals(result.right.emails, ["ada@example.com"]);
    assertEquals(result.right.tags, ["math", "computing"]);
    assertEquals(result.right.note, "first programmer");
    assert(result.right.createdAt instanceof Date);
    assert(result.right.updatedAt instanceof Date);
  }
});

Deno.test("PersonSchema accepts null id (newly-created record)", () => {
  const raw = { ...makeRawMockPerson(), id: null };
  const result = decodePerson(raw);
  assert(Either.isRight(result), "expected Right for null id");
});

Deno.test("PersonSchema rejects missing createdAt", () => {
  const { createdAt: _drop, ...raw } = makeRawMockPerson();
  const result = decodePerson(raw);
  assert(Either.isLeft(result), "expected Left for missing createdAt");
});

Deno.test("PersonSchema rejects missing updatedAt", () => {
  const { updatedAt: _drop, ...raw } = makeRawMockPerson();
  const result = decodePerson(raw);
  assert(Either.isLeft(result), "expected Left for missing updatedAt");
});

Deno.test("PersonSchema rejects non-Date createdAt", () => {
  // A plain string is not a Date; Schema.Date only accepts Date instances
  // (or numeric epoch ms). Strings are caught here, which is what we want:
  // the adapter is responsible for parsing ISO strings before constructing
  // a PersonShape.
  const raw = { ...makeRawMockPerson(), createdAt: "2024-01-01T00:00:00Z" };
  const result = decodePerson(raw);
  assert(Either.isLeft(result), "expected Left for string createdAt");
});

Deno.test("PersonSchema rejects missing firstName", () => {
  const { firstName: _drop, ...raw } = makeRawMockPerson();
  const result = decodePerson(raw);
  assert(Either.isLeft(result), "expected Left for missing firstName");
});

Deno.test("PersonSchema rejects non-array phoneNumbers", () => {
  const raw = { ...makeRawMockPerson(), phoneNumbers: "+44-0" };
  const result = decodePerson(raw);
  assert(Either.isLeft(result), "expected Left for non-array phoneNumbers");
});

Deno.test("PersonSchema rejects non-string element in phoneNumbers", () => {
  const raw = { ...makeRawMockPerson(), phoneNumbers: [42] };
  const result = decodePerson(raw);
  assert(Either.isLeft(result), "expected Left for numeric phone entry");
});

// PersonInputSchema: the user-supplied create payload. It MUST NOT carry
// id, createdAt, or updatedAt — those are system-managed. Per Effect's
// default `Schema.Struct` behavior, those fields are silently stripped on
// decode (the type itself doesn't have them). We test that the schema
// does not include these fields on the decoded result, and that supplying
// them in the input has no effect on the decoded shape.
Deno.test("PersonInputSchema decodes a user create payload (no id, no dates)", () => {
  const raw = {
    firstName: "Ada",
    lastName: "Lovelace",
    phoneNumbers: ["+44-0"],
    emails: ["ada@example.com"],
    tags: ["math"],
    note: "first programmer",
  };
  const result = decodeInput(raw);
  assert(Either.isRight(result), "expected Right for valid input");
  if (Either.isRight(result)) {
    // The decoded type does not have id/createdAt/updatedAt.
    assertEquals(
      Object.keys(result.right).sort(),
      [
        "emails",
        "firstName",
        "lastName",
        "note",
        "phoneNumbers",
        "tags",
      ],
    );
  }
});

Deno.test("PersonInputSchema silently strips system-managed fields", () => {
  // The user supplies id/createdAt/updatedAt in the JSON. The schema
  // ignores them on decode (they're not part of the user input). The
  // adapter enforces the no-system-fields contract on top.
  const raw = {
    id: "user-supplied-id",
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    firstName: "Ada",
    lastName: "Lovelace",
    phoneNumbers: [],
    emails: [],
    tags: [],
    note: "",
  };
  const result = decodeInput(raw);
  assert(Either.isRight(result), "expected Right — extras are stripped");
  if (Either.isRight(result)) {
    // The "id" key was supplied in the input but is not a property on the
    // decoded shape. We assert this by checking the decoded shape's keys
    // don't include "id", "createdAt", or "updatedAt".
    assert(!("id" in result.right));
    assert(!("createdAt" in result.right));
    assert(!("updatedAt" in result.right));
  }
});

Deno.test("PersonInputSchema rejects missing firstName", () => {
  const raw = {
    lastName: "Lovelace",
    phoneNumbers: [],
    emails: [],
    tags: [],
    note: "",
  };
  const result = decodeInput(raw);
  assert(Either.isLeft(result), "expected Left for missing firstName");
});

Deno.test("PersonInputSchema rejects wrong type for firstName", () => {
  const raw = {
    firstName: 123,
    lastName: "Lovelace",
    phoneNumbers: [],
    emails: [],
    tags: [],
    note: "",
  };
  const result = decodeInput(raw);
  assert(Either.isLeft(result), "expected Left for numeric firstName");
});

// PersonPatchSchema: a partial subset, every field optional. The
// system-managed fields are excluded from the type, so they're stripped
// if supplied.
Deno.test("PersonPatchSchema decodes an empty object (no-op patch)", () => {
  const result = decodePatch({});
  assert(Either.isRight(result), "expected Right for empty patch");
  if (Either.isRight(result)) {
    assertEquals(result.right, {});
  }
});

Deno.test("PersonPatchSchema decodes a single-field patch", () => {
  const result = decodePatch({ note: "analytical engine" });
  assert(Either.isRight(result), "expected Right for single-field patch");
  if (Either.isRight(result)) {
    assertEquals(result.right.note, "analytical engine");
  }
});

Deno.test("PersonPatchSchema decodes a multi-field patch", () => {
  const result = decodePatch({
    note: "x",
    tags: ["a", "b"],
    firstName: "Augusta",
  });
  assert(Either.isRight(result), "expected Right for multi-field patch");
});

Deno.test("PersonPatchSchema silently strips system-managed fields", () => {
  // id/createdAt/updatedAt on a patch have no effect — they're not
  // patchable. The adapter is the real gatekeeper; the schema simply
  // doesn't carry those fields.
  const result = decodePatch({
    id: "new-id",
    createdAt: new Date(),
    updatedAt: new Date(),
    note: "ok",
  });
  assert(Either.isRight(result), "expected Right — extras are stripped");
  if (Either.isRight(result)) {
    assert(!("id" in result.right));
    assert(!("createdAt" in result.right));
    assert(!("updatedAt" in result.right));
    assertEquals(result.right.note, "ok");
  }
});

Deno.test("PersonPatchSchema rejects wrong type for tags", () => {
  const result = decodePatch({ tags: 42 });
  assert(
    Either.isLeft(result),
    "expected Left — tags must be a string array when present",
  );
});

Deno.test("PersonPatchSchema rejects wrong type for firstName", () => {
  const result = decodePatch({ firstName: 123 });
  assert(
    Either.isLeft(result),
    "expected Left — firstName must be a string when present",
  );
});
