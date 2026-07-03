import {
  ConfigError,
  ConfigProvider,
  Console,
  Effect,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { DBService, DBServiceError, PersonInput } from "./db/port.ts";
import {
  PersonInputSchema,
  PersonPatchSchema,
  PersonShape,
} from "../schemas/Person/index.ts";
import { LowDBServiceLive } from "./db/LowDBAdapter.ts";

type SearchMode = "name" | "id" | "tag";

interface ParsedArgs {
  subcommand: "search" | "create" | "update" | "stats" | "tags" | "help";
  searchMode?: SearchMode;
  searchQuery?: string;
  createJson?: string;
  updateId?: string;
  updateJson?: string;
}

const HELP_TEXT = `rolodex — terminal interface to the local contacts database

USAGE:
  deno task rolodex search --name <query>
  deno task rolodex search --id   <query>
  deno task rolodex search --tag  <query>
  deno task rolodex create <contact-json>
  deno task rolodex update <id> <contact-json>
  deno task rolodex stats
  deno task rolodex tags
  deno task rolodex help

EXAMPLES:
  deno task rolodex search --name ada
  deno task rolodex search --id   6a46ebbc5d3cdd56844aba92
  deno task rolodex search --tag  computing
  deno task rolodex create '{"firstName":"Ada","lastName":"Lovelace","phoneNumbers":["+44-0"],"emails":["ada@example.com"],"tags":["math","computing"],"note":"first programmer"}'
  deno task rolodex update 6a46ebbc5d3cdd56844aba92 '{"note":"analytical engine","tags":["math","computing","history"]}'
  deno task rolodex stats
  deno task rolodex tags

ENV:
  DB_FILE_LOCATION  Path to the JSON database file (file adapter).
  MONGO_URI         mongodb:// connection string (Mongo adapter).
  MONGO_DB          Database name (default: rolodex).
  MONGO_COLLECTION  Collection name (default: contacts).`;

const usageError = (msg: string): never => {
  console.error(`error: ${msg}\n`);
  console.error(HELP_TEXT);
  Deno.exit(2);
};

const parseSearch = (
  rest: string[],
): { searchMode: SearchMode; searchQuery: string } => {
  const flags = rest.filter((r) => r.startsWith("--"));
  if (flags.length === 0) {
    return usageError("search requires one of --name, --id, --tag");
  }
  if (flags.length > 1) {
    return usageError("search accepts exactly one of --name, --id, --tag");
  }
  const flag = flags[0];
  const idx = rest.indexOf(flag);
  const value = rest[idx + 1];
  if (!value) return usageError(`${flag} requires a value`);
  // All three search modes take a string. The adapter validates the shape of
  // the value (e.g. MongoDB's adapter checks for a 24-char ObjectId hex) and
  // returns None on miss.
  if (flag === "--name") return { searchMode: "name", searchQuery: value };
  if (flag === "--id") return { searchMode: "id", searchQuery: value };
  if (flag === "--tag") return { searchMode: "tag", searchQuery: value };
  return usageError(`unknown search flag: ${flag}`);
};

const parseArgs = (args: string[]): ParsedArgs => {
  if (
    args.length === 0 || args[0] === "help" || args[0] === "--help" ||
    args[0] === "-h"
  ) {
    return { subcommand: "help" };
  }

  const [subcommand, ...rest] = args;

  if (subcommand === "search") {
    return { subcommand: "search", ...parseSearch(rest) };
  }

  if (subcommand === "create") {
    if (rest.length !== 1) {
      return usageError(
        "create requires exactly one positional argument: the contact JSON",
      );
    }
    return { subcommand: "create", createJson: rest[0] };
  }

  if (subcommand === "update") {
    if (rest.length !== 2) {
      return usageError(
        "update requires exactly two positional arguments: <id> <contact-json>",
      );
    }
    const [idStr, jsonStr] = rest;
    return { subcommand: "update", updateId: idStr, updateJson: jsonStr };
  }

  if (subcommand === "stats") {
    if (rest.length !== 0) {
      return usageError("stats takes no arguments");
    }
    return { subcommand: "stats" };
  }

  if (subcommand === "tags") {
    if (rest.length !== 0) {
      return usageError("tags takes no arguments");
    }
    return { subcommand: "tags" };
  }

  return usageError(`unknown subcommand: ${subcommand}`);
};

const renderContact = (p: PersonShape): string => {
  const idStr = p.id == null ? "(unassigned)" : String(p.id);
  const phones = p.phoneNumbers.length ? p.phoneNumbers.join(", ") : "—";
  const emails = p.emails.length ? p.emails.join(", ") : "—";
  const tags = p.tags.length ? p.tags.join(", ") : "—";
  return [
    `#${idStr}  ${p.firstName} ${p.lastName}`,
    `  phones : ${phones}`,
    `  emails : ${emails}`,
    `  tags   : ${tags}`,
    `  note   : ${p.note}`,
    `  created: ${p.createdAt.toISOString()}`,
    `  updated: ${p.updatedAt.toISOString()}`,
  ].join("\n");
};

const runSearch = (mode: SearchMode, query: string) =>
  Effect.gen(function* () {
    const db = yield* DBService;
    if (mode === "name") {
      const result = yield* db.getContactsByName(query);
      if (result._tag === "None" || result.value.length === 0) {
        return yield* Console.log("(no contacts)");
      }
      yield* Console.log(
        `${result.value.length} contact(s) matching name "${query}":`,
      );
      return yield* Console.log(result.value.map(renderContact).join("\n\n"));
    }
    if (mode === "id") {
      const result = yield* db.getContactsById(query);
      if (result._tag === "None") {
        return yield* Console.log(`(no contact with id ${query})`);
      }
      return yield* Console.log(renderContact(result.value));
    }
    // mode === "tag"
    const result = yield* db.getContactsByTag(query);
    if (result._tag === "None" || result.value.length === 0) {
      return yield* Console.log(`(no contacts with tag "${query}")`);
    }
    yield* Console.log(
      `${result.value.length} contact(s) with tag "${query}":`,
    );
    return yield* Console.log(result.value.map(renderContact).join("\n\n"));
  });

const runCreate = (rawJson: string) =>
  Effect.gen(function* () {
    const db = yield* DBService;

    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(rawJson),
      catch: (err: unknown) =>
        new DBServiceError({
          message: `Invalid JSON: ${(err as Error).message}`,
        }),
    });

    // Decode the user payload against the input schema (no id, no
    // timestamps — both are system-managed). The adapter fills them in.
    const decoded = yield* Schema.decodeUnknown(PersonInputSchema)(parsed).pipe(
      Effect.mapError((err) =>
        new DBServiceError({
          message: `Contact JSON does not match schema: ${err.message}`,
        })
      ),
    );

    // id is forced to null on create — the user said no updates, only
    // creation. The adapter will assign a real id, plus createdAt and
    // updatedAt.
    const fresh: PersonInput = { ...decoded, id: null };

    const saved = yield* db.saveContact(fresh);
    yield* Console.log("created:");
    yield* Console.log(renderContact(saved));
  });

const runUpdate = (id: string, rawJson: string) =>
  Effect.gen(function* () {
    const db = yield* DBService;

    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(rawJson),
      catch: (err: unknown) =>
        new DBServiceError({
          message: `Invalid JSON: ${(err as Error).message}`,
        }),
    });

    // A patch may carry any subset of the Person fields. Each field is still
    // type-checked (e.g. if `tags` is present it must be a string array).
    // `id` on the patch is ignored by the adapter — the row is matched by the
    // command-line id.
    const decoded = yield* Schema.decodeUnknown(PersonPatchSchema)(parsed).pipe(
      Effect.mapError((err) =>
        new DBServiceError({
          message: `Update JSON does not match schema: ${err.message}`,
        })
      ),
    );

    const updated = yield* db.updateContact(id, decoded);
    yield* Console.log("updated:");
    yield* Console.log(renderContact(updated));
  });

const runStats = () =>
  Effect.gen(function* () {
    const db = yield* DBService;
    const stats = yield* db.getStats();
    // JSON output so downstream tools (jq, scripts) can consume it cleanly.
    // The pretty-printing matches the on-disk file adapter's format so a
    // human reading the output gets a familiar shape.
    yield* Console.log(JSON.stringify(stats, null, 2));
  });

const runTags = () =>
  Effect.gen(function* () {
    const db = yield* DBService;
    const tags = yield* db.getTags();
    // JSON array of strings, pretty-printed. Empty DB → [] (still valid
    // JSON, still machine-friendly, still human-readable).
    yield* Console.log(JSON.stringify(tags, null, 2));
  });

// Build a runtime that pulls DB_FILE_LOCATION from the env (with a default).
const buildRuntime = (): ManagedRuntime.ManagedRuntime<
  DBService,
  DBServiceError | ConfigError.ConfigError
> => {
  const dbFile = Deno.env.get("DB_FILE_LOCATION") ?? "./rolodex-db.json";
  const ConfigLive = Layer.setConfigProvider(
    ConfigProvider.fromMap(new Map([["DB_FILE_LOCATION", dbFile]])),
  );
  const Live = LowDBServiceLive.pipe(Layer.provide(ConfigLive));
  return ManagedRuntime.make(Live);
};

const handleError = (cause: unknown): Effect.Effect<never, never, never> =>
  Console.error(`error: ${String(cause).replace(/^Error: /, "")}`).pipe(
    Effect.zipRight(Effect.sync(() => Deno.exit(1))),
  );

export const runCLI = async (args: string[]): Promise<void> => {
  const parsed = parseArgs(args);
  const program = Effect.gen(function* () {
    switch (parsed.subcommand) {
      case "help":
        return yield* Console.log(HELP_TEXT);
      case "search":
        return yield* runSearch(parsed.searchMode!, parsed.searchQuery!);
      case "create":
        return yield* runCreate(parsed.createJson!);
      case "update":
        return yield* runUpdate(parsed.updateId!, parsed.updateJson!);
      case "stats":
        return yield* runStats();
      case "tags":
        return yield* runTags();
    }
  });

  // Convert any failure (DB, Config, or our own DBServiceError) into a friendly
  // stderr message + non-zero exit. Success path is unchanged.
  const safe = program.pipe(
    Effect.catchAll((cause: unknown) => handleError(cause)),
    Effect.catchAllDefect((defect: unknown) =>
      handleError(defect instanceof Error ? defect.message : String(defect))
    ),
  );

  const runtime = buildRuntime();
  try {
    await runtime.runPromise(safe);
  } finally {
    await runtime.dispose();
  }
};
