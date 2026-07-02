import { runCLI } from "./services/cli.ts";

if (import.meta.main) {
  await runCLI(Deno.args);
}
