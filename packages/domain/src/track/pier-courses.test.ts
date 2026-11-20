import { describe, expect, it } from "vitest";
import { pierCourses } from "./pier-courses.ts";

describe("pierCourses", () => {
  it("stacks the most tall courses that still leave a whole number of short ones", () => {
    for (let height = 1; height <= 60; height++) {
      const courses = pierCourses(height, 3, 1);
      expect(courses && courses.tall * 3 + courses.short).toBe(height);
      expect(courses?.short).toBeLessThan(3);
    }
    expect(pierCourses(5, 3, 2)).toEqual({ tall: 1, short: 1 });
    expect(pierCourses(1, 3, 2)).toBeNull();
    expect(pierCourses(0, 3, 1)).toBeNull();
  });
});
