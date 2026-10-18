function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  sessionSecret: new TextEncoder().encode(required("TALLY_SESSION_SECRET")),
  sessionIssuer: process.env.TALLY_SESSION_ISSUER ?? "tally",
  defaultCurrency: process.env.TALLY_DEFAULT_CURRENCY ?? "USD",
  maxPageSize: 100,
};
