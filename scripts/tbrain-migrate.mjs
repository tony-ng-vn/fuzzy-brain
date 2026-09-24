import { runAdditiveMigration } from "./lib/additive-migration.mjs";

await runAdditiveMigration({ schemaFile: "tbrain-schema.sql", label: "Tbrain" });
