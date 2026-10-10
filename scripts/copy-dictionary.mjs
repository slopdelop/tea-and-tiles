import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("functions/lib/shared", { recursive: true });
for (const file of ["words.txt", "DICTIONARY-LICENSE.txt"])
  copyFileSync(`shared/${file}`, `functions/lib/shared/${file}`);
