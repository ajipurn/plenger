/** Exact injected CSS from pinned torph@0.1.3; requalify when upgrading Torph. */
export const TORPH_STYLE_HASH = "sha256-9FSs7KcrLRUSOwDMKKsTkMyDhNfMELkrw2Pw7LJTjZA=";

/** Exact drawer CSS that pinned vaul@1.1.2 injects on import; requalify when upgrading Vaul. */
export const VAUL_STYLE_HASH = "sha256-YIjArHm2rkb5J7hX9lUM1bnQ3Kp61MTfluMGkuyKwDw=";

/**
 * Vaul appends its `<style>` empty and fills it afterwards, so the browser checks the
 * empty stylesheet first. This hash admits only an empty stylesheet.
 */
export const EMPTY_STYLE_HASH = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

/** Library stylesheets the page injects without a nonce, as CSP source expressions. */
export const LIBRARY_STYLE_SOURCES = [TORPH_STYLE_HASH, VAUL_STYLE_HASH, EMPTY_STYLE_HASH]
  .map((hash) => `'${hash}'`)
  .join(" ");
