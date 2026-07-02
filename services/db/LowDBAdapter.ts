import { Config, ConfigError, Effect, Layer, Option } from "effect";
import { Low } from "lowdb";
import { DBService, DBServiceError, DBServicePort } from "./port";
import { DataBase } from "../../schemas/DataBase";
import { PersonShape } from "../../schemas/Person";

const defaultData: DataBase = { contacts: [] };

// Custom adapter that writes JSON directly to the target file. lowdb's bundled
// `JSONFile` uses `steno` for atomic writes (writes to `<dir>/.data.json.tmp`
// then renames), which breaks Deno's `--allow-write=./data.json` scope because
// the temp file lives at a different path. For a single-user terminal app,
// direct writes are fine.
const directJsonFile = (path: string) => ({
  read: async (): Promise<DataBase | null> => {
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
    if (text.trim() === "") return null;
    return JSON.parse(text) as DataBase;
  },
  write: async (data: DataBase): Promise<void> => {
    await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
  },
});

const linkDB = (db_file: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug("Linking local lowdb database.");
    const db = new Low<DataBase>(directJsonFile(db_file), defaultData);
    // Read may throw on invalid JSON; treat that as "use default and
    // rewrite the file" so a fresh `data.json` works without manual seeding.
    yield* Effect.tryPromise(() => db.read()).pipe(
      Effect.catchAll(() =>
        Effect.gen(function* () {
          db.data = defaultData;
          yield* Effect.tryPromise({
            try: () => db.write(),
            catch: (err: unknown) =>
              new DBServiceError({
                message: `Failed to seed database at ${db_file}: ${err}`,
              }),
          });
        })
      ),
    );
    return db;
  });

const fail = (message: string) => Effect.fail(new DBServiceError({ message }));

const matchesQuery = (text: string, query: string) =>
  text.toLowerCase().includes(query.toLowerCase());

export const LowDBServiceLive: Layer.Layer<
  DBService,
  ConfigError.ConfigError | DBServiceError,
  never
> = Layer.scoped(
  DBService,
  Effect.gen(function* () {
    const db_file = yield* Config.string("DB_FILE_LOCATION");
    const db = yield* linkDB(db_file);

    const getContactsByName: DBServicePort["getContactsByName"] = (query) =>
      Effect.gen(function* () {
        if (!db.data || !Array.isArray(db.data.contacts)) {
          return yield* fail(
            "Database is in an invalid state: missing contacts array.",
          );
        }
        const matches = db.data.contacts.filter((p: PersonShape) =>
          matchesQuery(p.firstName, query) ||
          matchesQuery(p.lastName, query)
        );
        return Option.some(matches);
      });

    const saveContact: DBServicePort["saveContact"] = (contact) =>
      Effect.gen(function* () {
        if (!db.data || !Array.isArray(db.data.contacts)) {
          return yield* fail(
            "Database is in an invalid state: missing contacts array.",
          );
        }
        const next: PersonShape = {
          ...contact,
          id: contact.id ?? Date.now(),
        };
        const existingIdx = db.data.contacts.findIndex(
          (p: PersonShape) => p.id != null && p.id === next.id,
        );
        if (existingIdx >= 0) {
          db.data.contacts[existingIdx] = next;
        } else {
          db.data.contacts.push(next);
        }
        yield* Effect.tryPromise(() => db.write()).pipe(
          Effect.catchAll((err) =>
            Effect.fail(
              new DBServiceError({
                message: `Failed to write database: ${err}`,
              }),
            )
          ),
        );
        return next;
      });

    const getContactsById: DBServicePort["getContactsById"] = (query) =>
      Effect.gen(function* () {
        if (!db.data || !Array.isArray(db.data.contacts)) {
          return yield* fail(
            "Database is in an invalid state: missing contacts array.",
          );
        }
        const match = db.data.contacts.find((p: PersonShape) => p.id === query);
        return match ? Option.some(match) : Option.none();
      });

    const getContactsByTag: DBServicePort["getContactsByTag"] = (query) =>
      Effect.gen(function* () {
        if (!db.data || !Array.isArray(db.data.contacts)) {
          return yield* fail(
            "Database is in an invalid state: missing contacts array.",
          );
        }
        const matches = db.data.contacts.filter((p: PersonShape) =>
          Array.isArray(p.tags) &&
          p.tags.some((tag: string) => matchesQuery(tag, query))
        );
        return Option.some(matches);
      });

    return {
      getContactsByName,
      saveContact,
      getContactsById,
      getContactsByTag,
    };
  }),
);
