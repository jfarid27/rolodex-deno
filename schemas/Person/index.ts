import { Schema } from "effect";

export const PhoneNumberSchema = Schema.String;
export const EmailSchema = Schema.String;

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
});

export type PersonShape = Schema.Schema.Type<typeof PersonSchema>;

// Patch schema: every field is optional so callers can supply only the values
// they want to change. Validated as a partial — if a field is present it must
// match the underlying type (e.g. `tags` if supplied must be a string array).
export const PersonPatchSchema = Schema.Struct({
  id: Schema.optional(Schema.NullishOr(Schema.String)),
  firstName: Schema.optional(Schema.String),
  lastName: Schema.optional(Schema.String),
  phoneNumbers: Schema.optional(Schema.Array(PhoneNumberSchema)),
  emails: Schema.optional(Schema.Array(EmailSchema)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  note: Schema.optional(Schema.String),
});

export type PersonPatchShape = Schema.Schema.Type<typeof PersonPatchSchema>;
