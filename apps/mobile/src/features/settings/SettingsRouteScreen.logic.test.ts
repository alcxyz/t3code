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
  it("distinguishes first eligibility from recurring eligibility", () => {
    expect(
      formatAutomaticTitleRenameLimitDescription({
        minAgeMinutes: 120,
        minCompletedTurns: 5,
        cooldownMinutes: 45,
        minFreshTurns: 2,
      }),
    ).toBe(
      "First update: 120 minutes old and 5 completed turns. Later updates: 45 minutes and 2 new completed turns.",
    );
  });
});
