# Web observation tools

Vanguard exposes two read-only network tools in conversation and execution
mode:

- `search_web` sends a bounded query to the configured public search endpoint
  and returns titles, URLs, and snippets.
- `fetch_url` retrieves one public HTTP(S) URL and returns bounded text,
  metadata, a content hash, and links extracted from HTML.

Neither tool carries browser state, cookies, provider credentials, arbitrary
headers, request bodies, or a shell. Both are observations: their output can
inform work but has no independent execution or review authority and cannot
prove a plan milestone.

## Network boundary

The default target policy accepts only HTTP and HTTPS on their default ports.
It rejects URL credentials, localhost names, `.local` names, and IP addresses
that are loopback, private, link-local, documentation-only, multicast, or
otherwise non-routable. Every redirect is parsed and authorized again before
it is followed. DNS answers are checked before a request is issued.

Responses have a timeout, redirect ceiling, and decoded-byte ceiling. A
declared `Content-Length` above the ceiling is rejected before the body is
read; an unannounced oversized stream is cut off at the ceiling. HTML scripts,
styles, templates, and SVG bodies are omitted from model-readable text.

These controls prevent the web tools from becoming a convenient local-network
or unbounded-download primitive. They are not an OS network sandbox and do not
confine project subprocesses.

## Trust and privacy

Web pages and search results are untrusted input. They can be stale, false, or
contain prompt-injection text. The kernel records them as ordinary tool
observations, not trusted verification evidence.

Queries and requested URLs are transmitted to external services. Do not put
repository secrets, credentials, personal data, or proprietary source text in
a query or URL. The tools do not inspect or redact the semantic content of a
model-generated query.

