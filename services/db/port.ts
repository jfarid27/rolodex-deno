import { Context, Data, Effect, Option } from "effect";
import { PersonShape } from "../../schemas/Person";

export const DBServiceErrorTag = "Rolodex.services.DBServiceError";
export class DBServiceError extends Data.TaggedError(DBServiceErrorTag)<{
  message: string;
}> {}

export interface DBServicePort {
  readonly getContactsByName: (
    query: string,
  ) => Effect.Effect<Option.Option<PersonShape[]>, DBServiceError>;
  readonly saveContact: (
    contact: PersonShape,
  ) => Effect.Effect<PersonShape, DBServiceError>;
  readonly getContactsById: (
    query: string,
  ) => Effect.Effect<Option.Option<PersonShape>, DBServiceError>;
  readonly getContactsByTag: (
    query: string,
  ) => Effect.Effect<Option.Option<PersonShape[]>, DBServiceError>;
  // Cross-field search. Matches the query as a case-insensitive substring
  // against any of: firstName, lastName, any tag, and the note. Returns
  // every contact that matches on at least one of those fields.
  readonly searchContacts: (
    query: string,
  ) => Effect.Effect<Option.Option<PersonShape[]>, DBServiceError>;
  readonly updateContact: (
    id: string,
    patch: Partial<PersonShape>,
  ) => Effect.Effect<PersonShape, DBServiceError>;
}

export class DBService extends Context.Tag("Rolodex.services.DBService")<
  DBService,
  DBServicePort
>() {}
