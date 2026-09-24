import { runAdditiveMigration } from "./lib/additive-migration.mjs";

await runAdditiveMigration({ schemaFile: "session-schema.sql", label: "Session checkpoint" });
