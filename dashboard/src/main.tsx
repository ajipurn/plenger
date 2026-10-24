import { setNonce } from "get-nonce";
import { OverlayScrollbars } from "overlayscrollbars";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app/App.tsx";
import { legacyHashTarget } from "./app/routes.ts";
import { verticalScrollbars } from "./shared/scrollbars.ts";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/sacramento/latin-400.css";
import "./styles/styles.css";
import "./styles/scrollbars.css";

// Preserve bookmarks from the first dashboard while moving to real routes.
const legacy = legacyHashTarget(window.location.hash.slice(1));
if (window.location.pathname === "/" && legacy) {
  window.history.replaceState(null, "", legacy);
}
const nonce = document.querySelector<HTMLMetaElement>('meta[name="plenger-style-nonce"]')?.content;
OverlayScrollbars.nonce(nonce);
// Vaul's Radix scroll lock injects a stylesheet through react-style-singleton.
if (nonce) setNonce(nonce);
// Keep document scrolling and modal scroll locking on the real viewport.
OverlayScrollbars(
  { target: document.body, elements: { viewport: document.body }, cancel: { body: null } },
  verticalScrollbars,
);

const element = document.getElementById("root");
if (!element) throw new Error("Dashboard root is missing.");
createRoot(element).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
