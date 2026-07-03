import { Schema } from "effect";

export const PhoneNumberSchema = Schema.String;
export const EmailSchema = Schema.String;

// PersonSchema is the full in-memory record shape. It is the source of truth
// for the type the adapters round-trip and what callers (CLI rendering,
// adapter tests) see. The id and the two timestamps are system-managed:
// the adapters assign id on create, set createdAt + updatedAt on create, and
// bump updatedAt on every update. They are not part of the user-supplied
// create or update payloads.
//
// `Schema.DateFromSelf` is used so the in-memory type is `Date` and the
// schema only accepts `Date` instances. The adapters are responsible for
// converting between the on-disk / on-wire representation (ISO string in
// JSON, BSON Date in MongoDB) and `Date` on the way in and out — the
// schema deliberately does not silently coerce strings, so a "looks-like-
// a-date" string from disk is caught at the adapter boundary rather than
// the schema boundary.
const PersonTimestampSchema = Schema.DateFromSelf;
export const PersonSchema = Schema.Struct({
  // id is a string so both adapters can use the same shape: the lowdb
  // adapter generates UUIDs; the MongoDB adapter uses ObjectId hex strings.
  // Both render and match identically from the CLI's point of view.
  id: Schema.NullishOr(Schema.String),
  firstName: Schema.String,
  lastName: Schema.String,
  phoneNumbers: Schema.Array(PhoneNumberSchema),
  emails: Schema.Array(EmailSchema),
  tags: Schema.Array(Schema.String),
  note: Schema.String,
  // Set by the adapter on first save; preserved across updates.
  createdAt: PersonTimestampSchema,
  // Set by the adapter on every save AND on every update.
  updatedAt: PersonTimestampSchema,
});

export type PersonShape = Schema.Schema.Type<typeof PersonSchema>;

// PersonInputSchema is what the CLI decodes a `create` JSON payload against.
// It contains only the user-supplied fields — id and the two timestamps are
// deliberately absent because they are system-managed. The adapter fills them
// in once the input has been validated.
export const PersonInputSchema = Schema.Struct({
  firstName: Schema.String,
  lastName: Schema.String,
  phoneNumbers: Schema.Array(PhoneNumberSchema),
  emails: Schema.Array(EmailSchema),
  tags: Schema.Array(Schema.String),
  note: Schema.String,
});

export type PersonInputShape = Schema.Schema.Type<typeof PersonInputSchema>;

// Patch schema: every field is optional so callers can supply only the values
// they want to change. Validated as a partial — if a field is present it must
// match the underlying type (e.g. `tags` if supplied must be a string array).
// `id`, `createdAt`, and `updatedAt` are not patchable: the row is anchored by
// the command-line id, and the two timestamps are system-managed (the
// adapter bumps `updatedAt` on every successful update).
export const PersonPatchSchema = Schema.Struct({
  firstName: Schema.optional(Schema.String),
  lastName: Schema.optional(Schema.String),
  phoneNumbers: Schema.optional(Schema.Array(PhoneNumberSchema)),
  emails: Schema.optional(Schema.Array(EmailSchema)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  note: Schema.optional(Schema.String),
});

export type PersonPatchShape = Schema.Schema.Type<typeof PersonPatchSchema>;
