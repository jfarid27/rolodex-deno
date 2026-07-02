import { Schema } from "effect";

export const PhoneNumberSchema = Schema.String;
export const EmailSchema = Schema.String;

export const PersonSchema = Schema.Struct({
  id: Schema.NullishOr(Schema.Number),
  firstName: Schema.String,
  lastName: Schema.String,
  phoneNumbers: Schema.Array(PhoneNumberSchema),
  emails: Schema.Array(EmailSchema),
  tags: Schema.Array(Schema.String),
  note: Schema.String,
});

export type PersonShape = Schema.Schema.Type<typeof PersonSchema>;
