import { runAdditiveMigration } from "./lib/additive-migration.mjs";

await runAdditiveMigration({ schemaFile: "recall-schema.sql", label: "Recall index" });
