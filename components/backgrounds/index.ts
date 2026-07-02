import GalaxyBackground from "./GalaxyBackground";

// Every background is a motion style. New styles register here; flipping
// ACTIVE_BACKGROUND changes the sky. Deliberately no chooser UI yet.
export const BACKGROUNDS = {
  galaxy: GalaxyBackground,
} as const;

export type BackgroundStyle = keyof typeof BACKGROUNDS;

export const ACTIVE_BACKGROUND: BackgroundStyle = "galaxy";
