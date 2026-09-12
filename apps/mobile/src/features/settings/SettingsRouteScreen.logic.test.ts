import { describe, expect, it } from "vite-plus/test";

import {
  formatAutomaticTitleRenameLimitDescription,
  resolveAgentAwarenessPlatformPresentation,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("supports agent awareness settings on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });

  it("leaves supported iOS settings unchanged", () => {
    expect(resolveAgentAwarenessPlatformPresentation("ios")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });
});

describe("formatAutomaticTitleRenameLimitDescription", () => {
  it("distinguishes first eligibility from recurring eligibility without a rolling cap", () => {
    expect(
      formatAutomaticTitleRenameLimitDescription({
        minAgeMinutes: 120,
        minCompletedTurns: 5,
        cooldownMinutes: 45,
        minFreshTurns: 2,
        rollingLimit: null,
      }),
    ).toBe(
      "The first update requires 120 minutes and 5 completed turns. After the last feature-generated title update, another requires 45 minutes and 2 new completed turns. No rolling limit.",
    );
  });

  it("describes the optional rolling limit", () => {
    expect(
      formatAutomaticTitleRenameLimitDescription({
        minAgeMinutes: 30,
        minCompletedTurns: 3,
        cooldownMinutes: 15,
        minFreshTurns: 1,
        rollingLimit: { maxCount: 2, windowHours: 24 },
      }),
    ).toContain("1 new completed turn. At most 2 updates per rolling 24-hour window.");
  });
});
