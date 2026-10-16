import { previewMove, type Game, type Placement } from "../shared/engine";

// Deliberately simple test opponent. The real engine validates every crossword.
export function findSoakMove(
  game: Game,
  dictionary: Set<string>,
): Placement[] | null {
  const rack = game.racks[game.turn];
  const anchors = Object.values(game.board);
  const words = [...dictionary].filter(
    (word) => word.length >= 2 && word.length <= 8,
  );
  // Vary the search order without making a failing run irreproducible.
  const offset = (game.revision * 7919) % words.length;
  for (let index = 0; index < words.length; index++) {
    const word = words[(index + offset) % words.length];
    for (const vertical of [false, true]) {
      const dr = vertical ? 1 : 0,
        dc = vertical ? 0 : 1;
      const starts: [number, number][] = anchors.length
        ? anchors.flatMap((anchor) =>
            [...word].flatMap((letter, position) =>
              letter === anchor.letter
                ? [
                    [
                      anchor.row - dr * position,
                      anchor.col - dc * position,
                    ] as [number, number],
                  ]
                : [],
            ),
          )
        : [[7, 7 - (vertical ? 0 : Math.floor(word.length / 2))]];
      for (const [row, col] of starts) {
        if (
          row < 0 ||
          col < 0 ||
          row + dr * (word.length - 1) > 14 ||
          col + dc * (word.length - 1) > 14
        )
          continue;
        if (
          game.board[`${row - dr},${col - dc}`] ||
          game.board[`${row + dr * word.length},${col + dc * word.length}`]
        )
          continue;
        const available = [...rack];
        const placements: Placement[] = [];
        let valid = true;
        for (let position = 0; position < word.length; position++) {
          const r = row + dr * position,
            c = col + dc * position;
          const existing = game.board[`${r},${c}`];
          if (existing) {
            if (existing.letter !== word[position]) {
              valid = false;
              break;
            }
            continue;
          }
          let tileIndex = available.findIndex(
            (tile) => tile.letter === word[position],
          );
          if (tileIndex < 0)
            tileIndex = available.findIndex((tile) => tile.letter === "?");
          if (tileIndex < 0) {
            valid = false;
            break;
          }
          const tile = available.splice(tileIndex, 1)[0];
          placements.push({
            tileId: tile.id,
            row: r,
            col: c,
            ...(tile.letter === "?" ? { letter: word[position] } : {}),
          });
        }
        if (!valid || !placements.length) continue;
        try {
          previewMove(game, rack, placements, dictionary);
          return placements;
        } catch {
          /* Try another legal word. */
        }
      }
    }
  }
  return null;
}
