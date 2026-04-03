import process from "node:process";
import { syncAllData } from "./data-sync-lib.mjs";

syncAllData().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
