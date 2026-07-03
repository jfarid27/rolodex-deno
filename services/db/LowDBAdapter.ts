import { Config, ConfigError, Effect, Layer, Option } from "effect";
import { Low } from "lowdb";
import { DBService, DBServiceError, DBServicePort } from "./port";
import { DataBase } from "../../schemas/DataBase";
import { PersonShape } from "../../schemas/Person";

// Epoch sentinel used when a record predates the timestamp feature and was
// therefore never given a createdAt/updatedAt. Distinct from "right now" so
// it's obvious from the CLI that the value was backfilled, not measured.
const EPOCH = new Date(0);

// Factory for a fresh empty default DB. Low mutates its `data` in place on
// read/write, so handing the same defaultData reference to multiple Low
// instances would let earlier instances' data leak into later ones (and
// the per-test temp files in particular would all see accumulated state
// from prior tests). Always build a new object per Low instance.
const freshDefaultData = (): DataBase => ({ contacts: [] });

// Normalize a freshly-read record into the in-memory PersonShape. The file
// adapter persists dates as ISO strings (because JSON.stringify turns Date
// into an ISO string), so on read we have to convert them back to `Date`
// instances for the in-memory `PersonShape` to hold.
//
// `Schema.Date` is strict about its input type on decode, so we do the
// conversion at the adapter boundary rather than asking the schema to accept
// strings — that keeps the rest of the system (CLI rendering, tests) free of
// "is this a string or a Date?" branches.
//
// Records written before the timestamp feature was added have no
// createdAt/updatedAt at all. We backfill with the epoch sentinel rather
// than dropping the record or throwing, so old data files continue to load
// cleanly. The CLI renders the epoch as a recognisable date.
const hydrateContact = (raw: PersonShape): PersonShape => {
  const created = raw.createdAt == null
    ? EPOCH
    : raw.createdAt instanceof Date
    ? raw.createdAt
    : new Date(raw.createdAt as unknown as string);
  const updated = raw.updatedAt == null
    ? EPOCH
    : raw.updatedAt instanceof Date
    ? raw.updatedAt
    : new Date(raw.updatedAt as unknown as string);
  return { ...raw, createdAt: created, updatedAt: updated };
};

const hydrate = (data: DataBase): DataBase => ({
  contacts: data.contacts.map(hydrateContact),
});

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
    const db = new Low<DataBase>(directJsonFile(db_file), freshDefaultData());
    // Read may throw on invalid JSON; treat that as "use default and
    // rewrite the file" so a fresh `data.json` works without manual seeding.
    yield* Effect.tryPromise(() => db.read()).pipe(
      Effect.catchAll(() =>
        Effect.gen(function* () {
          db.data = freshDefaultData();
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
    // Normalize whatever we just read into the in-memory shape: convert
    // ISO-string dates back to Date, and backfill missing timestamps with
    // the epoch sentinel. We mutate `db.data` in place (Low is designed for
    // this) so subsequent writes serialize the normalized form.
    if (db.data) {
      db.data = hydrate(db.data);
    }
    return db;
  });

const fail = (message: string) => Effect.fail(new DBServiceError({ message }));

const matchesQuery = (text: string, query: string) =>
  text.toLowerCase().includes(query.toLowerCase());

// Internal: build the DBService implementation bound to a specific file
// path. Used directly by tests (so they can pass a per-test temp file) and
// indirectly by LowDBServiceLive (which reads the path from Config).
const makeService = (
  db_file: string,
): Effect.Effect<DBServicePort, DBServiceError, never> =>
  Effect.gen(function* () {
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
        // Stamp both timestamps with "now" — createdAt for the first time
        // we see this id, and updatedAt because we're writing the row. The
        // port's input type doesn't carry timestamps (they're
        // system-managed), so we don't have to merge anything here.
        const now = new Date();
        const next: PersonShape = {
          ...contact,
          id: contact.id ?? crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
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

    const searchContacts: DBServicePort["searchContacts"] = (query) =>
      Effect.gen(function* () {
        if (!db.data || !Array.isArray(db.data.contacts)) {
          return yield* fail(
            "Database is in an invalid state: missing contacts array.",
          );
        }
        const matches = db.data.contacts.filter((p: PersonShape) =>
          matchesQuery(p.firstName, query) ||
          matchesQuery(p.lastName, query) ||
          matchesQuery(p.note, query) ||
          (Array.isArray(p.tags) &&
            p.tags.some((tag: string) => matchesQuery(tag, query)))
        );
        return Option.some(matches);
      });

    const updateContact: DBServicePort["updateContact"] = (id, patch) =>
      Effect.gen(function* () {
        if (!db.data || !Array.isArray(db.data.contacts)) {
          return yield* fail(
            "Database is in an invalid state: missing contacts array.",
          );
        }
        const idx = db.data.contacts.findIndex(
          (p: PersonShape) => p.id === id,
        );
        if (idx < 0) {
          return yield* fail(`No contact with id ${id}.`);
        }
        // Merge patch over the existing record. The adapter owns the
        // timestamp fields — `createdAt` is preserved from the existing
        // row, and `updatedAt` is bumped to "now" on every successful
        // update. The patch is not allowed to carry these fields (the
        // PersonPatchSchema doesn't include them), but we drop them
        // defensively in case a programmatic caller bypasses the schema.
        const {
          id: _ignoredId,
          createdAt: _ignoredCreated,
          updatedAt: _ignoredUpdated,
          ...rest
        } = patch;
        const existing = db.data.contacts[idx];
        const updated: PersonShape = {
          ...existing,
          ...rest,
          createdAt: existing.createdAt,
          updatedAt: new Date(),
        };
        db.data.contacts[idx] = updated;
        yield* Effect.tryPromise(() => db.write()).pipe(
          Effect.catchAll((err) =>
            Effect.fail(
              new DBServiceError({
                message: `Failed to write database: ${err}`,
              }),
            )
          ),
        );
        return updated;
      });

    const getStats: DBServicePort["getStats"] = () =>
      Effect.gen(function* () {
        if (!db.data || !Array.isArray(db.data.contacts)) {
          return yield* fail(
            "Database is in an invalid state: missing contacts array.",
          );
        }
        // Count whatever the on-disk/in-memory list actually contains. We
        // trust the array length rather than re-validating each row, so a
        // future "soft-deleted" flag or filter on this array would be
        // reflected automatically.
        return { counts: { contacts: db.data.contacts.length } };
      });

    return {
      getContactsByName,
      saveContact,
      getContactsById,
      getContactsByTag,
      searchContacts,
      updateContact,
      getStats,
    };
  });

// Build a DBService layer bound to a specific file path. Exported for tests;
// production code uses LowDBServiceLive below (which reads the path from
// the DB_FILE_LOCATION env var via Effect's Config).
export const makeLowDBService = (
  db_file: string,
): Layer.Layer<DBService, DBServiceError, never> =>
  Layer.scoped(
    DBService,
    makeService(db_file),
  );

export const LowDBServiceLive: Layer.Layer<
  DBService,
  ConfigError.ConfigError | DBServiceError,
  never
> = Layer.scoped(
  DBService,
  Effect.gen(function* () {
    const db_file = yield* Config.string("DB_FILE_LOCATION");
    return yield* makeService(db_file);
  }),
);
