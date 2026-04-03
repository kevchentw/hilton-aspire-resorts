import process from "node:process";
import { syncPrices } from "./data-sync-lib.mjs";

syncPrices().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
