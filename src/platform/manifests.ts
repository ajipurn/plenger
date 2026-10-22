import { locate, substitute } from "./dockerfile.ts";
import { phpImage, UNRESOLVED } from "./images.ts";
import type { RuntimeImage } from "./model.ts";

/** `image: php:8.3-fpm`, also as a list item. */
const IMAGE = /^\s*(?:-\s+)?image:\s*["']?([^\s"'#]+)/;
/** Kubernetes manifests start a document with these keys. */
const MANIFEST = /^apiVersion:\s*\S/m;
const KIND = /^kind:\s*\S/m;

/**
 * PHP images in a Compose file, or in another YAML file when it is a Kubernetes manifest.
 * Compose variables take their `${NAME:-default}`; other variables have no value.
 */
export function readManifest(path: string, text: string, compose: boolean): RuntimeImage[] {
  if (!compose && !(MANIFEST.test(text) && KIND.test(text))) return [];
  const images: RuntimeImage[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const written = IMAGE.exec(raw)?.[1];
    if (written === undefined) return;
    const reference = substitute(written, new Map());
    const image = phpImage(reference);
    if (image === null) return;
    images.push({
      kind: "image",
      runtime: "php",
      reference: reference.includes(UNRESOLVED) ? written : reference,
      ...image,
      location: locate(path, index + 1, raw, written),
      source: compose ? "compose" : "manifest",
    });
  });
  return images;
}
