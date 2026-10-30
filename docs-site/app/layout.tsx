import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Provider } from "../components/provider.tsx";
import "./global.css";

export const metadata: Metadata = {
  title: { default: "Plenger documentation", template: "%s | Plenger docs" },
  description:
    "Get started with local repository security review, AI validation and STRIDE threat modeling.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-dvh flex-col antialiased">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
