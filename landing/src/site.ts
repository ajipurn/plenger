/** Facts the page states about itself, shared by the head tags and structured data. */
export const SITE = {
  name: "Plenger",
  title: "Plenger | Security review that runs locally",
  description:
    "Plenger traces the risk, checks the claim and cites the line. AI source review, a second skeptical pass and STRIDE, from one npm package on your machine.",
  socialDescription:
    "Traces the risk, checks the claim, cites the line. AI source review, a second skeptical pass and STRIDE, in a dashboard on your machine.",
  repository: "https://github.com/ajipurn/plenger",
  author: "Aji Purnomo",
  license: "https://www.apache.org/licenses/LICENSE-2.0",
  image: { path: "/og.jpg", width: 1200, height: 630, alt: "Security review that runs locally." },
} as const;
