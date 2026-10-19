# AI review on real projects, Batch and Explore, 2026-10-19

One Quick review per mode on three open-source projects, to see what each mode
reports outside the synthetic corpus. It establishes behaviour on these three
snapshots only.

## Configuration

- Connection: saved provider "Claude 2", model `claude-haiku-5-5`, its saved
  prices and catalog window. A host-side script ran `reviewProject` on each
  project's static scan, with text files listed as the dashboard lists them.
- Projects, shallow clones read only and never run: SuperAGI (Python agent
  platform, 564 reviewable files), gpt-researcher (Python research agent with a
  FastAPI backend, 552) and Vercel's ai-chatbot (Next.js, 168).
- Explore with the cache breakpoint on every turn, the 16,384-token output
  allowance and strict submit tools. Prompt digests as in the cross-file record
  plus the earlier-sessions instruction.

## Results

| Project | Mode | Requests | Files read or sent | Findings (source-supported) | Cache read / written / uncached input tokens | Estimated USD |
| --- | --- | --- | --- | --- | --- | --- |
| SuperAGI | Batch | 2 | 3 | 5 (4) | 0 / 0 / 31,052 | 0.11 |
| SuperAGI | Explore | 8 | 8 | 6 (6) | 175,655 / 59,668 / 20 | 0.32 |
| gpt-researcher | Batch | 2 | 4 | 3 (1) | 0 / 0 / 27,806 | 0.07 |
| gpt-researcher | Explore | 10 | 8 | 4 (4) | 228,006 / 66,811 / 24 | 0.35 |
| ai-chatbot | Batch | 2 | 3 | 2 (1) | 0 / 0 / 31,154 | 0.09 |
| ai-chatbot | Explore | 12 | 18 | 2 (2) | 387,333 / 59,633 / 28 | 0.34 |

All six reviews completed. Prices are the connection's saved prices.

## Findings read against the code

Four Explore findings were checked line by line:

- SuperAGI: `check_auth` requires a JWT only when `ENV` is `PROD`, and
  `get_current_user` maps every request to one fixed account in `DEV`, the
  template default. Accurate.
- SuperAGI: in `PROD` a Basic `Authorization` header's username becomes the
  account email and the password is never checked. Accurate as code; whether a
  JWT can be sent at the same time depends on where AuthJWT reads it, which the
  finding assumes.
- gpt-researcher: the report and chat routes have no authentication, and
  listing without ids returns every report. Accurate; the impact depends on how
  the backend is exposed.
- ai-chatbot: the vote lookup filters by message id only, while the update
  filters by chat and message. Accurate, low impact.

The other findings were not read one by one.

## Observations

- On SuperAGI and gpt-researcher, Explore reported more findings with fewer
  needs-review verdicts. On SuperAGI both modes found the plaintext passwords
  and the unauthenticated LLM key endpoints. Only Batch reported the GitHub
  login binding and the JWT in a redirect; only Explore the `DEV` bypass, the
  Basic header identity, the default JWT secret and the email and password
  overwrite.
- Caching works: in every exploring review nearly all input after the first
  turn was a cache read, and uncached input was under 30 tokens. Explore still
  cost three to four times a batch, because it made 4 to 6 times as many
  requests and wrote each turn's new part to the cache.
- Quick reads little of a project of this size in either mode: 3 to 18 of 168
  to 564 files.

## Not established

More than one run per project, other models and transports, Full coverage, a
full reading of every finding, and recall: nothing here says what either mode
missed.
