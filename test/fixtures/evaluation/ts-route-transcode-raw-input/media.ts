import { spawnSync } from "node:child_process";
import path from "node:path";

const MEDIA = path.resolve("media");

export function transcode(input: string): number | null {
  return spawnSync("ffmpeg", ["-i", input, "-f", "mp3", "pipe:1"]).status;
}

export function mediaPath(name: string): string {
  return path.resolve(MEDIA, name);
}
