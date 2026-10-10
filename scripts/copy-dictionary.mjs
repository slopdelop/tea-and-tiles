import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
mkdirSync("functions/lib/shared", { recursive: true });
for (const file of ["words.txt", "DICTIONARY-LICENSE.txt"])
  copyFileSync(`shared/${file}`, `functions/lib/shared/${file}`);
const metadata = "shared/DICTIONARY-SOURCE.json";
const deployedMetadata = "functions/lib/shared/DICTIONARY-SOURCE.json";
if (existsSync(metadata)) copyFileSync(metadata, deployedMetadata);
else rmSync(deployedMetadata, { force: true });
