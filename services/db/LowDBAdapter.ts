import { Effect, Layer, Config } from "effect";
import { DBService } from "./port";
import { JSONFile } from "lowdb/node";
import { DataBase } from "../../schemas/DataBase";

const linkDB = (db_file: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug("Linking local lowdb database.");
    return new JSONFile<DataBase>(db_file);
  }).pipe(Effect.orDie);

export const LowDBServiceLive = Layer.scoped(
  DBService,
  Effect.gen(function* () {
    const db_file = yield* Config.string("DB_FILE_LOCATION");
    const db = yield* linkDB(db_file);

    // TODO: Implement lowdb DB service.
    return Effect.fail({});
  }),
);
