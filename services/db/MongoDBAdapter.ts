import { Config, ConfigError, Effect, Layer, Option } from "effect";
import { Collection, MongoClient, ObjectId } from "mongodb";
import { DBService, DBServiceError, DBServicePort } from "./port.ts";
import { PersonShape } from "../../schemas/Person/index.ts";

// MongoDB-backed implementation of the DBService port.
//
// Configuration (read from the env via Effect's Config):
//   MONGO_URI         Required. mongodb:// connection string.
//   MONGO_DB          Optional. Defaults to "rolodex".
//   MONGO_COLLECTION  Optional. Defaults to "contacts".
//
// Wiring this adapter instead of LowDBServiceLive means changing
// services/index.ts (or composing the layer manually) — the two adapters
// are interchangeable at the port level.
//
// Permission flags: the mongodb driver opens network sockets, so the rolodex
// task needs `--allow-net=<host>` (or `--allow-net` for development) in
// addition to the env/read flags.

type ContactDoc = Omit<PersonShape, "id" | "createdAt" | "updatedAt"> & {
  // MongoDB's own identifier. We never expose this to the CLI — the public
  // PersonShape.id is the hex string of this ObjectId, and that's what
  // callers see and use to match.
  _id?: ObjectId;
  // `id` is intentionally absent from the persisted shape. The CLI's
  // PersonShape.id is always derived from _id; we never round-trip it
  // through Mongo, which avoids any "is this the doc's id or the public
  // id?" ambiguity.
  //
  // createdAt / updatedAt are stored as BSON Date (the native Mongo type),
  // so we expose them on the persisted shape and re-attach them to the
  // public PersonShape on the way out.
  createdAt: Date;
  updatedAt: Date;
};

const toPerson = (doc: ContactDoc | null): PersonShape | null => {
  if (!doc) return null;
  // Strip Mongo's _id; expose it as the public string id. If for some reason
  // _id is missing (e.g. a malformed legacy record), leave id null so the
  // shape stays well-formed.
  const { _id, ...rest } = doc;
  return _id ? { ...rest, id: _id.toString() } : { ...rest, id: null };
};

const matchesQuery = (text: string, query: string) =>
  text.toLowerCase().includes(query.toLowerCase());

const fail = (message: string): Effect.Effect<never, DBServiceError> =>
  Effect.fail(new DBServiceError({ message }));

const wrap = <A, E>(
  effect: Effect.Effect<A, E>,
  message: string,
): Effect.Effect<A, DBServiceError> =>
  effect.pipe(
    Effect.mapError((cause) =>
      new DBServiceError({ message: `${message}: ${String(cause)}` })
    ),
  );

const isValidObjectId = (s: string): boolean => /^[0-9a-fA-F]{24}$/.test(s);

export const MongoDBServiceLive: Layer.Layer<
  DBService,
  ConfigError.ConfigError | DBServiceError,
  never
> = Layer.scoped(
  DBService,
  Effect.gen(function* () {
    const uri = yield* Config.string("MONGO_URI");
    const dbName = yield* Config.string("MONGO_DB").pipe(
      Config.withDefault("rolodex"),
    );
    const collectionName = yield* Config.string("MONGO_COLLECTION").pipe(
      Config.withDefault("contacts"),
    );

    yield* Effect.logDebug(
      `Connecting to MongoDB at ${uri}, db=${dbName}, collection=${collectionName}`,
    );
    const client = new MongoClient(uri);
    yield* Effect.tryPromise(() => client.connect()).pipe(
      Effect.mapError((cause) =>
        new DBServiceError({
          message: `MongoDB connect failed: ${String(cause)}`,
        })
      ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => client.close()).pipe(Effect.ignoreLogged)
    );
    const collection: Collection<ContactDoc> = client
      .db(dbName)
      .collection<ContactDoc>(collectionName);

    const getContactsByName: DBServicePort["getContactsByName"] = (query) =>
      Effect.gen(function* () {
        const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(safe, "i");
        const docs = yield* wrap(
          Effect.tryPromise(() =>
            collection
              .find({ $or: [{ firstName: regex }, { lastName: regex }] })
              .toArray()
          ),
          "MongoDB find by name failed",
        );
        const matches = docs
          .map(toPerson)
          .filter((p): p is PersonShape => p !== null);
        return Option.some(matches);
      });

    const saveContact: DBServicePort["saveContact"] = (contact) =>
      Effect.gen(function* () {
        // The CLI forces id to null on create, so a missing/null id means
        // "this is a new row". An explicit id means "upsert into this row".
        const incomingId = contact.id ?? null;
        const hasId = incomingId !== null && incomingId !== undefined;

        if (hasId && !isValidObjectId(incomingId as string)) {
          return yield* fail(
            `saveContact: id "${incomingId}" is not a valid ObjectId hex string.`,
          );
        }

        // Build the document to write. We never persist Mongo's _id as the
        // public id; we always derive it from _id on the way out. The id
        // field is dropped here (the upsert path re-derives it from _id,
        // the insert path uses Mongo's auto-assigned _id). The two
        // timestamp fields are owned by the adapter — stamp them now.
        const { id: _ignoredId, ...rest } = contact;
        const now = new Date();
        const doc: ContactDoc = {
          ...rest,
          createdAt: now,
          updatedAt: now,
        };

        if (hasId) {
          const _id = new ObjectId(incomingId as string);
          yield* wrap(
            Effect.tryPromise(() =>
              collection.replaceOne({ _id }, doc, { upsert: true })
            ),
            "MongoDB replaceOne failed",
          );
          return { ...doc, id: _id.toString() };
        }

        // No id → insert and let Mongo assign _id, then return it as the
        // public id.
        const inserted = yield* wrap(
          Effect.tryPromise(() => collection.insertOne(doc)),
          "MongoDB insertOne failed",
        );
        return { ...doc, id: inserted.insertedId.toString() };
      });

    const getContactsById: DBServicePort["getContactsById"] = (query) =>
      Effect.gen(function* () {
        if (!isValidObjectId(query)) {
          // Match the lowdb adapter's contract: an unknown id returns None.
          return Option.none();
        }
        const doc = yield* wrap(
          Effect.tryPromise(() =>
            collection.findOne({ _id: new ObjectId(query) })
          ),
          "MongoDB findOne by id failed",
        );
        const person = toPerson(doc);
        return person ? Option.some(person) : Option.none();
      });

    const getContactsByTag: DBServicePort["getContactsByTag"] = (query) =>
      Effect.gen(function* () {
        const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(safe, "i");
        const docs = yield* wrap(
          Effect.tryPromise(() => collection.find({ tags: regex }).toArray()),
          "MongoDB find by tag failed",
        );
        const matches = docs
          .map(toPerson)
          .filter((p): p is PersonShape =>
            p !== null && Array.isArray(p.tags) &&
            p.tags.some((tag: string) => matchesQuery(tag, query))
          );
        return Option.some(matches);
      });

    const searchContacts: DBServicePort["searchContacts"] = (query) =>
      Effect.gen(function* () {
        const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(safe, "i");
        // Single $or across all four searchable fields. The application-level
        // filter below applies the same per-field substring semantics the
        // lowdb adapter uses, so the two adapters return identical results
        // for the same data.
        const docs = yield* wrap(
          Effect.tryPromise(() =>
            collection.find({
              $or: [
                { firstName: regex },
                { lastName: regex },
                { note: regex },
                { tags: regex },
              ],
            }).toArray()
          ),
          "MongoDB cross-field search failed",
        );
        const matches = docs.map(toPerson).filter((p): p is PersonShape => {
          if (p === null) return false;
          return (
            matchesQuery(p.firstName, query) ||
            matchesQuery(p.lastName, query) ||
            matchesQuery(p.note, query) ||
            (Array.isArray(p.tags) &&
              p.tags.some((tag: string) => matchesQuery(tag, query)))
          );
        });
        return Option.some(matches);
      });

    const updateContact: DBServicePort["updateContact"] = (id, patch) =>
      Effect.gen(function* () {
        if (!isValidObjectId(id)) {
          return yield* fail(`No contact with id ${id}.`);
        }
        // Drop id, createdAt, and updatedAt from the patch — the row is
        // anchored by the command-line id, and the two timestamps are
        // system-managed. We bump updatedAt to "now" on every successful
        // update; createdAt is preserved by never being in the $set.
        const {
          id: _ignoredId,
          createdAt: _ignoredCreated,
          updatedAt: _ignoredUpdated,
          ...rest
        } = patch;
        if (Object.keys(rest).length === 0) {
          // Empty patch: read and return the current record, no write.
          const current = yield* getContactsById(id);
          if (current._tag === "None") {
            return yield* fail(`No contact with id ${id}.`);
          }
          return current.value;
        }
        const updated = yield* wrap(
          Effect.tryPromise(() =>
            collection.findOneAndUpdate(
              { _id: new ObjectId(id) },
              { $set: { ...rest, updatedAt: new Date() } },
              { returnDocument: "after" },
            )
          ),
          "MongoDB findOneAndUpdate failed",
        );
        const person = toPerson(updated);
        if (!person) {
          return yield* fail(`No contact with id ${id}.`);
        }
        return person;
      });

    const getStats: DBServicePort["getStats"] = () =>
      Effect.gen(function* () {
        // countDocuments is the canonical aggregate; estimatedDocumentCount
        // skips the scan but can return a stale value on a sharded cluster
        // and ignores any filter we might add later, so we use the precise
        // count for a small personal-rolodex dataset.
        const n = yield* wrap(
          Effect.tryPromise(() => collection.countDocuments()),
          "MongoDB countDocuments failed",
        );
        return { counts: { contacts: n } };
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
  }),
);
