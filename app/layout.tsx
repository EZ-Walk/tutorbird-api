import type { ReactNode } from "react";

export const metadata = {
  title: "TutorBird MCP",
  description: "Unofficial TutorBird MCP proxy. The server stores no API key.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
