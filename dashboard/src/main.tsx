import { CSPProvider } from "@base-ui/react/csp-provider";
import { OverlayScrollbars } from "overlayscrollbars";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.tsx";
import { verticalScrollbars } from "./scrollbars.ts";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/nanum-pen-script/latin-400.css";
import "./styles.css";
import "./scrollbars.css";

// Preserve bookmarks from the first dashboard while moving to real routes.
const legacy = /^(overview|findings|inventory|redteam|history)(\?.*)?$/.exec(
  window.location.hash.slice(1),
);
if (window.location.pathname === "/" && legacy) {
  const path = legacy[1] === "overview" ? "/" : `/${legacy[1]}`;
  window.history.replaceState(null, "", `${path}${legacy[2] ?? ""}`);
}
const nonce = document.querySelector<HTMLMetaElement>('meta[name="plenger-style-nonce"]')?.content;
OverlayScrollbars.nonce(nonce);
// Keep document scrolling and Base UI's modal scroll lock on the real viewport.
OverlayScrollbars(
  { target: document.body, elements: { viewport: document.body }, cancel: { body: null } },
  verticalScrollbars,
);

const element = document.getElementById("root");
if (!element) throw new Error("Dashboard root is missing.");
createRoot(element).render(
  <StrictMode>
    <CSPProvider nonce={nonce}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </CSPProvider>
  </StrictMode>,
);
