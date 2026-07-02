import { Effect, Option, Data, Context } from "effect";
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
    query: number,
  ) => Effect.Effect<Option.Option<PersonShape>, DBServiceError>;
  readonly getContactsByTag: (
    query: string,
  ) => Effect.Effect<Option.Option<PersonShape[]>, DBServiceError>;
}

export class DBService extends Context.Tag("Rolodex.services.DBService")<
  DBService,
  DBServicePort
>() {}
