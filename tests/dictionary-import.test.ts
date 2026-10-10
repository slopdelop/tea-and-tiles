import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  validateDictionary,
  installDictionary,
} from "../scripts/import-dictionary.mjs";
import { previewMove, DISTRIBUTION, type Tile } from "../shared/engine";

const notice =
  "Synthetic test lexicon only. Permission to copy and distribute this fixture is granted.\n";
const temporary: string[] = [];
const tempRoot = () => {
  const path = mkdtempSync(join(tmpdir(), "tea-dictionary-test-"));
  temporary.push(path);
  return path;
};
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("authorized modern dictionary import", () => {
  it("normalizes BOM, Windows newlines and case into sorted unique ASCII entries with reproducible provenance", () => {
    const source = "\uFEFFtea\r\nCAT\r\ncat\r\nAT\r\n\r\n";
    const result = validateDictionary(
      source,
      "NWL2023",
      notice,
      "C:/private/licensed-words.txt",
    );
    expect(result.words).toBe("AT\nCAT\nTEA\n");
    expect(result.metadata).toMatchObject({
      edition: "NWL2023",
      wordCount: 3,
      sourceFile: "licensed-words.txt",
      publisherUrl: "https://www.scrabbleplayers.org/w/NWL2023",
    });
    expect(result.metadata.normalizedSha256).toBe(
      createHash("sha256").update(result.words).digest("hex"),
    );
    expect(result.metadata.noticeSha256).toBe(
      createHash("sha256").update(notice).digest("hex"),
    );
    expect(result.metadata.sourceSha256).not.toBe(
      result.metadata.normalizedSha256,
    );
  });

  it("rejects TR, older editions, missing notices and definitions or non-ASCII input rather than silently dropping them", () => {
    for (const source of [
      "CAT\nTR\n",
      "CAT\ntr\n",
      "CAT\nÉTÉ\n",
      "CAT\nA\n",
      "CAT\nABCDEFGHIJKLMNOP\n",
      "CAT\ncan't\n",
      "CAT a feline\n",
      "<html>CAT</html>\n",
      "\n",
    ])
      expect(() =>
        validateDictionary(source, "WOW24", notice, "words.txt"),
      ).toThrow();
    for (const edition of ["NWL2020", "ENABLE", "CSW2024", ""])
      expect(() =>
        validateDictionary("CAT\n", edition, notice, "words.txt"),
      ).toThrow(/Edition/);
    expect(() =>
      validateDictionary("CAT\n", "NSWL2023", "  ", "words.txt"),
    ).toThrow(/notice/);
  });

  it("CLI validation is the default and makes no dictionary, notice or metadata writes", () => {
    const root = tempRoot();
    const source = join(root, "words.txt");
    const permission = join(root, "notice.txt");
    writeFileSync(source, "TEA\nCAT\nAT\n");
    writeFileSync(permission, notice);
    const output = execFileSync(
      process.execPath,
      [
        resolve("scripts/import-dictionary.mjs"),
        "--source",
        source,
        "--edition",
        "NSWL2023",
        "--notice",
        permission,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toMatchObject({
      installed: false,
      edition: "NSWL2023",
      wordCount: 3,
    });
    expect(existsSync(join(root, "shared"))).toBe(false);
    expect(existsSync(join(root, "public"))).toBe(false);
    expect(readFileSync(source, "utf8")).toBe("TEA\nCAT\nAT\n");
  });

  it("installs one identical normalized lexicon and notice plus metadata for frontend and backend builds", () => {
    const root = tempRoot();
    // Fabricated ASCII words exercise file synchronization without shipping or
    // claiming an actual copyrighted tournament lexicon in these tests.
    const source = Array.from({ length: 1000 }, (_, index) =>
      [Math.floor(index / 676), Math.floor(index / 26) % 26, index % 26]
        .map((letter) => String.fromCharCode(65 + letter))
        .join(""),
    )
      .reverse()
      .join("\n");
    const dictionary = validateDictionary(
      source,
      "WOW24",
      notice,
      "synthetic-fixture.txt",
    );
    installDictionary(dictionary, root);
    expect(readFileSync(join(root, "shared/words.txt"), "utf8")).toBe(
      dictionary.words,
    );
    for (const folder of ["shared", "public"]) {
      expect(
        readFileSync(join(root, folder, "DICTIONARY-LICENSE.txt"), "utf8"),
      ).toBe(notice);
      expect(
        JSON.parse(
          readFileSync(join(root, folder, "DICTIONARY-SOURCE.json"), "utf8"),
        ),
      ).toEqual(dictionary.metadata);
    }
  });

  it("rejects an incomplete install before creating files", () => {
    const root = tempRoot();
    expect(() =>
      installDictionary(
        validateDictionary("CAT\n", "NWL2023", notice, "fixture.txt"),
        root,
      ),
    ).toThrow(/full lexicon/);
    expect(existsSync(join(root, "shared"))).toBe(false);
  });
});

describe("current prototype correction", () => {
  it("rejects an actual TR board play while accepting common words through the real bundled dictionary", () => {
    const dictionary = new Set(
      readFileSync(resolve("shared/words.txt"), "utf8").trim().split(/\r?\n/),
    );
    const preview = (word: string) => {
      const rack: Tile[] = [...word].map((letter, index) => ({
        id: `tile-${index}`,
        letter,
        value: DISTRIBUTION[letter][1],
      }));
      return previewMove(
        { board: {} },
        rack,
        rack.map((tile, index) => ({
          tileId: tile.id,
          row: 7,
          col: 7 + index,
        })),
        dictionary,
      );
    };
    expect(dictionary.has("TR")).toBe(false);
    expect(() => preview("TR")).toThrow(/Not in our dictionary: TR/);
    for (const word of ["AT", "CAT", "TEA", "DOG"])
      expect(preview(word).words).toEqual([word]);
  });
});
