import { runAdditiveMigration } from "./lib/additive-migration.mjs";

await runAdditiveMigration({ schemaFile: "memory-schema.sql", label: "Memory receipt" });
