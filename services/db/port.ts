import { Context, Data, Effect, Option } from "effect";
// Re-export `PersonShape` here so consumers of the port can pull both
// `PersonShape` (the full in-memory record) and `PersonInput` (what
// `saveContact` accepts) from a single import.
export type { PersonShape } from "../../schemas/Person";
import { PersonShape } from "../../schemas/Person";

// PersonInput is the type the adapters' `saveContact` accepts. It's the full
// in-memory shape minus the two system-managed timestamps: id may be set
// (upsert into a known row) or null/undefined (insert a new row), and the
// adapter will fill in id, createdAt, and updatedAt as needed.
export type PersonInput = Omit<PersonShape, "createdAt" | "updatedAt"> & {
  id: string | null | undefined;
};

export const DBServiceErrorTag = "Rolodex.services.DBServiceError";
export class DBServiceError extends Data.TaggedError(DBServiceErrorTag)<{
  message: string;
}> {}

export interface DBServicePort {
  readonly getContactsByName: (
    query: string,
  ) => Effect.Effect<Option.Option<PersonShape[]>, DBServiceError>;
  readonly saveContact: (
    contact: PersonInput,
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
  // Aggregate stats over the current contents of the database. Returned
  // shape is `{ counts: { contacts: number, ... } }` so future fields
  // (e.g. `tags`, `recent`) can be added without breaking callers.
  readonly getStats: () => Effect.Effect<
    { counts: { contacts: number } },
    DBServiceError
  >;
}

export class DBService extends Context.Tag("Rolodex.services.DBService")<
  DBService,
  DBServicePort
>() {}
