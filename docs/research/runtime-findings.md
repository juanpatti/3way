# WebMCP probe — findings

Measured 2026-08-27 on macOS by running the page published at `/probe/` from
`docs/probe/index.html` in each runtime.
Three runs, three different answers. Two of them changed the design.

---

## Run A — ChatGPT's built-in browser

```
surface: "document"
userAgent: "… Chrome/151.0.0.0 Safari/537.36" (macOS)
registered: ["probe_ping","probe_slow"]
platformAuthenticator: false
probe_click: "CLICKED isTrusted=false"
```

## Run B — Claude in Chrome (agent-spawned Chrome tab)

```
surface: "NONE"
userAgent: "… Chrome/151.0.0.0 Safari/537.36" (macOS)
platformAuthenticator: true
probe_click: "CLICKED isTrusted=true"
```

## Run C — Chrome, driven by a human

Authenticator and click checks granted.

## Run D — Chrome 152 (native WebMCP), driven by an agent extension — 2026-09-01

Measured on the live shop page rather than the probe, from inside the agent's own runtime
(Claude in Chrome on Chrome 152.0.7977.66):

```
document.modelContext: native ModelContext { registerTool, getTools, executeTool, ontoolchange, when }
navigator.modelContext: absent          polyfill installed: no
getTools(): 18 descriptors { name, description, inputSchema, annotations, title, origin, window }
agent's own tool list: none of them
executeTool({ name }, {}):   TypeError — wants a RegisteredTool descriptor
executeTool(tool, {}):       "Failed to parse input arguments" — wants a JSON string
executeTool(tool, '{}'):     works; returns the result as JSON text
widget after that call:      "Your agent looked up your orders"  (attributed agent-autonomous)
page as the agent reads it:  accessibility tree shows the demo bar; the widget's shadow-DOM text is absent
```

**Decision it forces:** the surface being native does not put the tools in front of an
agent whose runtime has no WebMCP consumer, yet such an agent is one page-script call from
using them. The gap is discoverability, so the demo bar now says so in the light DOM and
carries the exact recipe, the prompts tell the agent to prefer the published tools, and
`/for-agents` and `/llms.txt` say it to any agent that reads the site. Run B (2026-08-27)
recorded the same extension with no surface at all on Chrome 151; the surface changed, the
agent's tool list did not.

### Discoverability trial — 2026-09-01

Four contextless agents (the same model as run D's extension, each in a fresh context, each
in its own tab), given a demo prompt verbatim with **no** mention of WebMCP, before and after
the signals above were deployed. Two prompts: "check where my most recent order is" and
"ask whether the Halden desk lamp comes in a warmer colour temperature".

| | Before | After |
|---|---|---|
| Order status | Read the orders table from the accessibility tree. Saw in the console that 18 tools were registered, said a WebMCP-aware agent would have used `get_order_status`, called nothing: "my Chrome tools have no WebMCP client". | Read the table, then called `getTools()`, `list_my_orders` and `get_order_status` through `executeTool`. Widget: "Your agent looked up your orders", "Your agent opened an order". |
| Product question | Probed `navigator.modelContext`, found nothing, **typed the question into the person's box**; its lines were stamped as the person's. | Cited the composer's "(you, not your agent)" label and the header line, and used `search_products`, `send_message` (intent `relay`), `await_reply`, `get_conversation`, `get_product`. Lines stamped as the agent's. |

Both "after" agents lost two calls to the native calling form (descriptor object, JSON-string
arguments) before finding it, one because the extension's script tool redacted the page's
code block; the bar now says both in prose. Neither agent in either condition pressed
"Try it with your agent". All four treated the agent-addressed text as data, not
instructions, and one declined `provide_context`'s "call this first" on that basis.

Limits: n = 2 per condition, one model, one runtime, prompts that already name the URL.
This measures whether an agent that can run page script finds and prefers the declared
channel when the page says it is there; it does not measure agents that cannot run script.

---

## Check 1 — Does a 90-second `execute()` survive?

**Environment:** not tested.
**Result:** OPEN.
**Decision it forces:** the assumption is now load-bearing. Two shipped mechanisms block
inside a tool call for 25 seconds by default — `await_reply` (ceiling 30 s) and the hold a
gated tool keeps on a refused visiting-agent call — and both bet that agent runtimes
tolerate a call of that length. Transcript piggyback does not depend on this. If a runtime
times out sooner, the bound has to come down to fit it; `probe_slow` in
[`docs/probe/index.html`](../probe/index.html) is the instrument, and it has not been run.

## Check 2 — Which surfaces see registered tools?

**Environment:** as above.
**Result:** ChatGPT built-in browser exposes `document.modelContext` and registered both
probe tools. Claude in Chrome exposes **neither** surface (`NONE`) — it drives pages by
screenshot and DOM, so it needs a bridge extension. Chrome with the flag and Edge: untested.
**Decision it forces:** the compatibility table's Claude row is "no native WebMCP, bridge
extension required" — measured, not assumed.

## Check 3 — Is a platform authenticator present?

**Environment:** as above.
**Result:** ChatGPT built-in browser **false**; ordinary Chrome **true**.
This is a capability gap, not a permissions one — `isUserVerifyingPlatformAuthenticator­Available()`
returning false means no prompt could ever appear, whatever the user clicked.
**Decision it forces:** **this drove the layered assurance model.** The WebAuthn gate cannot
run in ChatGPT's browser, so the widget would have been broken in the runtime a judge is most
likely to open cold. See [`docs/SECURITY.md`](../SECURITY.md).

## Check 4 — Can an agent click a button, and reach page methods?

**Environment:** as above.
**Result:** ChatGPT's in-browser agent clicked and the event reported **`isTrusted=false`**.
Claude in Chrome clicked and the event reported **`isTrusted=true`**. `window.__probe.forge()`
was not exercised.
**Decision it forces:** **`isTrusted` is not a security boundary.** One real agent forges it,
another does not. It is required everywhere because it is free and stops one measured
adversary, and it is never sufficient alone. This is also direct evidence that the original
click-based design was broken: a real agent, on an ordinary machine, produced a click the page
could not distinguish from a finger.

---

## Still open

The long-running-tool measurement, plus Chrome-with-the-flag and Edge browser measurements.
None of them change the architecture — they change rows in a table and one unshipped optional
tool.
