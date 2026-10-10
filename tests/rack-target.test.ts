import { describe, expect, it } from "vitest";
import {
  findRackInsertionIndex,
  rackTargetHysteresis,
} from "../src/rackTarget";

describe("rack vacancy targeting", () => {
  it("selects the displayed full-slot vacancy for every source and destination", () => {
    for (let count = 1; count <= 7; count++) {
      const tiles = Array.from(
        { length: count },
        (_, index) => `tile-${index}`,
      );
      const centers = tiles.map((_, index) => 100 + index * 55);
      for (let source = 0; source < count; source++) {
        const remaining = tiles.filter((_, index) => index !== source);
        for (let destination = 0; destination < count; destination++) {
          const index = findRackInsertionIndex(
            centers[destination],
            centers,
            source,
          );
          const reordered = [...remaining];
          reordered.splice(index, 0, tiles[source]);
          expect(index, `source ${source}, destination ${destination}`).toBe(
            destination,
          );
          expect(reordered[destination]).toBe(tiles[source]);
          expect(reordered.filter((tile) => tile !== tiles[source])).toEqual(
            remaining,
          );
        }
      }
    }
  });

  it("uses actual expanded board-return slot centers including the first and last", () => {
    // These include a centered expansion, a compressed narrow rack and the
    // single centered vacancy in an otherwise empty rack.
    for (const centers of [
      [72.5, 127.5, 182.5, 237.5],
      [91, 130, 169],
      [180],
    ]) {
      for (let destination = 0; destination < centers.length; destination++) {
        expect(findRackInsertionIndex(centers[destination], centers)).toBe(
          destination,
        );
        expect(
          findRackInsertionIndex(
            centers[destination],
            centers,
            centers.length - 1,
          ),
        ).toBe(destination);
      }
    }
  });

  it("holds the vacancy around a midpoint and switches in either direction beyond its buffer", () => {
    const centers = [100, 155, 210];
    expect(rackTargetHysteresis(centers)).toBe(6);
    let index = 0;
    for (const pointer of [125, 129, 127.5, 132, 133.5]) {
      index = findRackInsertionIndex(pointer, centers, index);
      expect(index).toBe(0);
    }
    index = findRackInsertionIndex(134, centers, index);
    expect(index).toBe(1);
    for (const pointer of [128, 124, 127.5, 121.5]) {
      index = findRackInsertionIndex(pointer, centers, index);
      expect(index).toBe(1);
    }
    expect(findRackInsertionIndex(121, centers, index)).toBe(0);
  });

  it("supports jumps, source-independent ties and small-slot proportional hysteresis", () => {
    const centers = [0, 20, 40, 60];
    expect(rackTargetHysteresis(centers)).toBe(2.4);
    expect(findRackInsertionIndex(60, centers, 0)).toBe(3);
    expect(findRackInsertionIndex(0, centers, 3)).toBe(0);
    expect(findRackInsertionIndex(10, centers)).toBe(0);
    expect(findRackInsertionIndex(-100, centers)).toBe(0);
    expect(findRackInsertionIndex(500, centers)).toBe(3);
    expect(findRackInsertionIndex(10, centers, 99)).toBe(0);
  });

  it("keeps stationary targets and translates pointer coordinates with viewport scrolling", () => {
    const centers = [150, 205, 260];
    let index = findRackInsertionIndex(205, centers);
    for (const pointer of [205, 206, 204, 205, 207, 205, 203, 205]) {
      index = findRackInsertionIndex(pointer, centers, index);
      expect(index).toBe(1);
    }
    // Page scrolling right by 30 puts the same stable slot at clientX 175.
    const scrollDelta = -30;
    expect(findRackInsertionIndex(175 - scrollDelta, centers, index)).toBe(1);
    expect(findRackInsertionIndex(0, [])).toBe(0);
  });
});
