import { describe, expect, test } from "bun:test";
import {
  KnapsackValidationError,
  type KnapsackProblem,
} from "../src/types.ts";
import { validateProblem } from "../src/validate.ts";
import { solve } from "../src/index.ts";

const ok = (over: Partial<KnapsackProblem> = {}): KnapsackProblem => ({
  groups: [{ id: "g", options: [{ id: "a", weight: 2, profit: 5 }] }],
  capacity: 10,
  ...over,
});

describe("validation", () => {
  test("accepts a well-formed problem", () => {
    expect(() => validateProblem(ok())).not.toThrow();
  });

  test("rejects fractional capacity", () => {
    expect(() => validateProblem(ok({ capacity: 3.5 }))).toThrow(
      KnapsackValidationError,
    );
  });

  test("rejects negative capacity", () => {
    expect(() => validateProblem(ok({ capacity: -1 }))).toThrow(
      KnapsackValidationError,
    );
  });

  test("rejects capacity above the arithmetic envelope", () => {
    expect(() => validateProblem(ok({ capacity: 0x200000 }))).toThrow(
      /capacity must stay below/,
    );
  });

  test("accepts capacity exactly at the envelope boundary", () => {
    expect(() => validateProblem(ok({ capacity: 0x1fffff }))).not.toThrow();
  });

  test("rejects zero groups", () => {
    expect(() => validateProblem(ok({ groups: [] }))).toThrow(
      /at least one group/,
    );
  });

  test("rejects duplicate group ids", () => {
    const g = { id: "dupe", options: [{ id: "a", weight: 1, profit: 1 }] };
    expect(() =>
      validateProblem({ groups: [g, { ...g }], capacity: 5 }),
    ).toThrow(/duplicate group id/);
  });

  test("rejects empty option arrays", () => {
    expect(() =>
      validateProblem(ok({ groups: [{ id: "g", options: [] }] })),
    ).toThrow(/at least one option/);
  });

  test("accepts exactly 255 options per group (u8 back-pointer cap)", () => {
    const options = Array.from({ length: 255 }, (_, i) => ({
      id: `o${i}`,
      weight: i + 1,
      profit: i * 3 + 1,
    }));
    expect(() =>
      validateProblem(ok({ groups: [{ id: "g", options }], capacity: 500 })),
    ).not.toThrow();
  });

  test("rejects 256 options per group, naming group and limit", () => {
    const options = Array.from({ length: 256 }, (_, i) => ({
      id: `o${i}`,
      weight: i + 1,
      profit: i * 3 + 1,
    }));
    expect(() =>
      validateProblem(ok({ groups: [{ id: "wide-group", options }] })),
    ).toThrow(/wide-group.*256 options.*at most 255/);
  });

  test("rejects fractional weights", () => {
    expect(() =>
      validateProblem(
        ok({ groups: [{ id: "g", options: [{ id: "a", weight: 1.5, profit: 1 }] }] }),
      ),
    ).toThrow(/weight must be a non-negative integer/);
  });

  test("rejects negative profits", () => {
    expect(() =>
      validateProblem(
        ok({ groups: [{ id: "g", options: [{ id: "a", weight: 1, profit: -2 }] }] }),
      ),
    ).toThrow(/profit must be a non-negative integer/);
  });

  test("rejects duplicate option ids within a group", () => {
    expect(() =>
      validateProblem(
        ok({
          groups: [
            {
              id: "g",
              options: [
                { id: "a", weight: 1, profit: 1 },
                { id: "a", weight: 2, profit: 2 },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/duplicate option id/);
  });

  test("same option id across different groups is legal", () => {
    const r = solve({
      groups: [
        { id: "g1", options: [{ id: "o0", weight: 1, profit: 1 }] },
        { id: "g2", options: [{ id: "o0", weight: 2, profit: 2 }] },
      ],
      capacity: 5,
    });
    expect(r.status).toBe("optimal");
    expect(r.value).toBe(3);
  });

  test("rejects profit sum at the Int32 ceiling", () => {
    const big = 0x40000000; // 2^30 per group; two groups sum past 2^31
    expect(() =>
      validateProblem({
        groups: [
          { id: "g1", options: [{ id: "a", weight: 1, profit: big }] },
          { id: "g2", options: [{ id: "a", weight: 1, profit: big }] },
        ],
        capacity: 10,
      }),
    ).toThrow(/must stay below/);
  });

  test("error messages name the offending value", () => {
    try {
      validateProblem(ok({ capacity: 0x200000 }));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("2097152");
      expect((e as Error).name).toBe("KnapsackValidationError");
    }
  });

  test("rejects non-array groups", () => {
    expect(() =>
      validateProblem({ groups: undefined, capacity: 5 } as unknown as KnapsackProblem),
    ).toThrow(KnapsackValidationError);
  });

  test("huge weights with small profits stay inside the envelope", () => {
    expect(() =>
      validateProblem(ok({
        groups: [{ id: "g", options: [{ id: "a", weight: 2 ** 40, profit: 8 }] }],
        capacity: 100,
      })),
    ).not.toThrow();
  });

  test("rejects when (Σ max profits)·(max weight) reaches 2^53", () => {
    // totalMaxProfit = 1 + 1 = 2, maxWeight = 2^52  ->  product exactly 2^53.
    expect(() =>
      validateProblem({
        groups: [
          { id: "g1", options: [{ id: "a", weight: 1, profit: 1 }] },
          { id: "g2", options: [{ id: "a", weight: 2 ** 52, profit: 1 }] },
        ],
        capacity: 10,
      }),
    ).toThrow(/exactness envelope exceeded/);
  });

  test("accepts just below the exactness envelope boundary", () => {
    // totalMaxProfit = 2, maxWeight = 2^52 − 1  ->  product 2^53 − 2 < 2^53.
    expect(() =>
      validateProblem({
        groups: [
          { id: "g1", options: [{ id: "a", weight: 1, profit: 1 }] },
          { id: "g2", options: [{ id: "a", weight: 2 ** 52 - 1, profit: 1 }] },
        ],
        capacity: 10,
      }),
    ).not.toThrow();
  });
});
