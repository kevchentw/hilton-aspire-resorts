import process from "node:process";
import { syncHotels } from "./data-sync-lib.mjs";

syncHotels().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
