import { spawnSync } from "node:child_process";

export const MISSING_IMAGEMAGICK_REASON =
  "ImageMagick (magick) is not installed; pixel comparison skipped";

/** Pixel comparison calls the `magick` command. An absolute ImageMagick 6 tool does not satisfy it. */
export function imageMagickCommandAvailable() {
  return spawnSync("magick", ["-version"], { encoding: "utf8" }).status === 0;
}

export function skipWithoutImageMagick(commandName) {
  if (imageMagickCommandAvailable()) return;
  console.log(`${commandName} skipped: ${MISSING_IMAGEMAGICK_REASON}`);
  process.exit(0);
}
