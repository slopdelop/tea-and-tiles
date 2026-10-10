import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export const EDITIONS = {
  NWL2023: "https://www.scrabbleplayers.org/w/NWL2023",
  NSWL2023: "https://www.scrabbleplayers.org/w/NSWL2023",
  WOW24: "https://wordgameplayers.org/wgpo-official-words/",
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// This checks a supplied words-only file; it does not download a lexicon,
// authenticate its publisher, or expand the rights in its permission notice.
export function validateDictionary(source, edition, notice, sourceName) {
  if (!Object.hasOwn(EDITIONS, edition))
    throw new Error("Edition must be NWL2023, NSWL2023 or WOW24.");
  if (typeof notice !== "string" || !notice.trim())
    throw new Error("Supply the dictionary's copyright and permission notice.");
  const words = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const entries = [];
  for (const [index, line] of words.entries()) {
    const word = line.trim();
    if (!word) continue;
    if (!/^[A-Za-z]{2,15}$/.test(word))
      throw new Error(
        `Invalid word on line ${index + 1}: expected 2–15 ASCII letters.`,
      );
    entries.push(word.toUpperCase());
  }
  if (!entries.length) throw new Error("The dictionary is empty.");
  if (entries.includes("TR"))
    throw new Error("TR is not valid in these recent tournament lexicons.");
  const normalized = [...new Set(entries)].sort().join("\n") + "\n";
  return {
    words: normalized,
    notice,
    metadata: {
      edition,
      publisherUrl: EDITIONS[edition],
      sourceFile: basename(sourceName),
      wordCount: new Set(entries).size,
      sourceSha256: sha256(source),
      normalizedSha256: sha256(normalized),
      noticeSha256: sha256(notice),
    },
  };
}

export function installDictionary(dictionary, rootDirectory) {
  // The client deliberately rejects tiny/HTML dictionary assets. Validation
  // remains useful for small fixtures, but installation must satisfy that guard.
  if (dictionary.metadata.wordCount < 1000)
    throw new Error(
      "Installation needs at least 1,000 unique words; supply the full lexicon.",
    );
  for (const folder of ["shared", "public"])
    mkdirSync(join(rootDirectory, folder), { recursive: true });
  const metadata = JSON.stringify(dictionary.metadata, null, 2) + "\n";
  writeFileSync(join(rootDirectory, "shared", "words.txt"), dictionary.words);
  for (const folder of ["shared", "public"]) {
    writeFileSync(
      join(rootDirectory, folder, "DICTIONARY-LICENSE.txt"),
      dictionary.notice,
    );
    writeFileSync(
      join(rootDirectory, folder, "DICTIONARY-SOURCE.json"),
      metadata,
    );
  }
}

export function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--install") options.install = true;
    else if (["--source", "--edition", "--notice"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}.`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.source || !options.edition || !options.notice)
    throw new Error(
      "Usage: node scripts/import-dictionary.mjs --source <local words.txt> --edition NWL2023|NSWL2023|WOW24 --notice <local notice.txt> [--install]",
    );
  for (const path of [options.source, options.notice])
    if (/^[a-z]+:\/\//i.test(path))
      throw new Error("Source and notice must be local files.");
  const dictionary = validateDictionary(
    readFileSync(resolve(options.source), "utf8"),
    options.edition,
    readFileSync(resolve(options.notice), "utf8"),
    options.source,
  );
  if (options.install) installDictionary(dictionary, resolve("."));
  process.stdout.write(
    JSON.stringify(
      { installed: !!options.install, ...dictionary.metadata },
      null,
      2,
    ) + "\n",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
