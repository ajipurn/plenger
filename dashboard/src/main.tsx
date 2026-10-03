import { CSPProvider } from "@base-ui/react/csp-provider";
import { OverlayScrollbars } from "overlayscrollbars";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.tsx";
import "@fontsource-variable/inter";
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
