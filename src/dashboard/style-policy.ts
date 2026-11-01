/** Exact injected CSS from pinned torph@0.1.3; requalify when upgrading Torph. */
export const TORPH_STYLE_HASH = "sha256-9FSs7KcrLRUSOwDMKKsTkMyDhNfMELkrw2Pw7LJTjZA=";

/** Exact drawer CSS from pinned vaul@1.1.2; requalify when upgrading Vaul. */
export const VAUL_STYLE_HASH = "sha256-YIjArHm2rkb5J7hX9lUM1bnQ3Kp61MTfluMGkuyKwDw=";

/** Exact toast CSS from pinned notch-toast@0.2.0; requalify when upgrading Notch Toast. */
export const NOTCH_TOAST_STYLE_HASH = "sha256-nRx5DdnDiKz/mBuxT+Y99CnIitHY3e9nz5tlYD4Yk+8=";

/** Vaul appends an empty style element before filling it with its stylesheet. */
export const EMPTY_STYLE_HASH = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

/** Library stylesheets the page injects without a nonce, as CSP source expressions. */
export const LIBRARY_STYLE_SOURCES = [
  TORPH_STYLE_HASH,
  VAUL_STYLE_HASH,
  NOTCH_TOAST_STYLE_HASH,
  EMPTY_STYLE_HASH,
]
  .map((hash) => `'${hash}'`)
  .join(" ");
