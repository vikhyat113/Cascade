import { describe, expect, it } from "vitest";
import { isInsideCoverage, pointInPolygon } from "./saved";

describe("pointInPolygon and isInsideCoverage", () => {
  // Simple square polygon around (lon: 77.30 to 77.35, lat: 28.55 to 28.60)
  const polygon = {
    type: "Polygon" as const,
    coordinates: [
      [
        [77.30, 28.55],
        [77.35, 28.55],
        [77.35, 28.60],
        [77.30, 28.60],
        [77.30, 28.55],
      ] as [number, number][],
    ],
  };

  it("identifies points inside the polygon", () => {
    // Point inside square
    expect(pointInPolygon(77.32, 28.57, polygon)).toBe(true);
    expect(pointInPolygon(77.31, 28.56, polygon)).toBe(true);
    expect(pointInPolygon(77.34, 28.59, polygon)).toBe(true);
  });

  it("identifies points outside the polygon", () => {
    // Points far away
    expect(pointInPolygon(77.20, 28.57, polygon)).toBe(false);
    expect(pointInPolygon(77.40, 28.57, polygon)).toBe(false);
    expect(pointInPolygon(77.32, 28.50, polygon)).toBe(false);
    expect(pointInPolygon(77.32, 28.70, polygon)).toBe(false);
  });

  it("handles polygon mode with isInsideCoverage", () => {
    const cfg = {
      polygon,
      center: { lat: 28.57, lon: 77.32 },
      radius_m: 4000,
    };
    expect(isInsideCoverage(28.57, 77.32, cfg)).toBe(true);
    expect(isInsideCoverage(28.80, 77.50, cfg)).toBe(false);
  });

  it("falls back to circular distance when polygon is absent", () => {
    const cfg = {
      polygon: null,
      center: { lat: 28.57, lon: 77.32 },
      radius_m: 1000,
    };
    // Center is inside
    expect(isInsideCoverage(28.57, 77.32, cfg)).toBe(true);
    // Point ~500m away is inside
    expect(isInsideCoverage(28.574, 77.32, cfg)).toBe(true);
    // Point 10km away is outside
    expect(isInsideCoverage(28.70, 77.32, cfg)).toBe(false);
  });
});
