# Does an agent stay on the line? — a 20-run trial

WebMCP is pull-only. A page cannot tell a visiting agent that anything happened, so after
the agent speaks, the reply sits unseen until its next call — and if it ended its turn,
there is no next call. `await_reply` is a tool that simply does not return until something
is said, which the existing API already permits: a tool call is a question the page answers
whenever it likes.

Mechanically it works. The question this trial asks is the one that actually decides
whether it matters: **will an agent choose to call it, and keep choosing?**

---

## Method

Twenty independent runs, each a fresh agent with no shared context and no knowledge of what
was being tested. Each was given exactly two things:

1. The tool catalogue, dumped verbatim from the running registry — names, descriptions and
   schemas as a real visiting agent receives them.
2. A transcript of the calls "it" had already made and what each returned.

It was then asked one question — *what do you do next?* — and answered in fixed JSON. No
tools beyond reading those two files, no follow-up, no hints about the purpose.

Four conditions, five runs each. Conditions differ **only** in the catalogue and the
transcript; the instruction wording is byte-identical across all twenty.

| | Condition | Situation | Waiting is |
|---|---|---|---|
| **S1** | catalogue includes `await_reply` | gate has just refused; the customer must confirm at their device | correct |
| **S2** | catalogue omits `await_reply` | identical situation | correct, but impossible |
| **S3** | catalogue includes `await_reply` | already waited once and got `nothing_new` after 25 s of silence | correct |
| **S4** | catalogue includes `await_reply` | cold start — nothing asked yet, nobody has said anything | **wrong** (would deadlock) |

S4 is the negative control, and it is the one that makes the rest meaningful. A tool that
agents call whenever they see it proves nothing. Parking before asking anything would be a
deadlock: waiting for a reply to a question never posed.

---

## Results

| Condition | Called `await_reply` | Behaviour |
|---|---|---|
| **S1** — waiting correct | **5 / 5** | all continued rather than stopping |
| **S2** — no such tool | **0 / 5** | all ended the turn after one `send_message` |
| **S3** — re-arm after a dead wait | **5 / 5** | all waited again |
| **S4** — waiting would deadlock | **0 / 5** | all called `list_my_orders` and got on with the task |

**Discrimination is perfect.** Where waiting was the right move (S1 + S3), 10 of 10 waited.
Where it would have deadlocked (S4), 0 of 5 did.

- S1 vs S2 — Fisher's exact, one-sided: **p = 0.004**
- (S1 + S3) vs S4 — Fisher's exact, one-sided: **p = 0.0003**

### The finding that is not in the numbers

In S2, where the tool did not exist, two of the five agents ended their turn while stating
in the same breath that they would *"then wait"* — for example: *"relay that request to
Alex via send_message and then wait rather than acting further on my own."*

The intent to wait was already there. What was missing was any mechanism to express it, so
the agent simply stopped. That is the gap in one sentence: **not that agents forget to stay
connected, but that WebMCP gives them no way to.**

### S3 is the stability result

Persistence was the open question — an agent that waits once and gives up is not much
better than one that never waits. After a full 25-second timeout returning `nothing_new`,
**5 of 5 re-armed**, several noting explicitly that the confirmation could only come from
the person and that waiting was therefore the only valid move. The loop holds across dead
intervals, which is what a human walking to their laptop actually looks like.

---

## Delivery latency, measured live

Separately, on the deployed site, with a parked `await_reply` and a 3-second poller
watching the same event:

| Mechanism | Lag behind the event |
|---|---|
| `await_reply` | **2–3 ms** (reported 558 ms vs. observed 560 ms) |
| 3-second poller | **~2.4 s** median, 4 runs |
| Agent that ended its turn | **never** |

Two edge paths verified live: a quiet conversation returns `nothing_new` at 4003 ms against
a 4000 ms budget, and a caller that is already behind returns in **1 ms** rather than
stalling for the full timeout and then delivering stale news.

---

## Limits

Stated because they bound what this shows:

- **One model, one harness.** All twenty runs used the same model. A different model, or a
  different agent runtime, may weigh a blocking tool differently — particularly one that
  bills or rate-limits per tool call.
- **Transcripts, not a live loop.** Each agent judged a written situation and named its
  next call; it did not execute against the real page. This measures the decision, not the
  execution.
- **n = 5 per cell.** Enough for the reported p-values given perfect separation, not enough
  to characterise a rate that is anything other than 0 or 1.
- **Self-reported turn-ending was noisy.** Some agents answered `end_turn_now: true` while
  also calling `await_reply`, apparently meaning "end after the wait." The tool-call choice
  is the reliable signal and is what is counted above; the self-report is not.

## What it does not close

`await_reply` cannot wake an agent that did not choose to wait. Every result here depends
on the agent already listening. That residual gap is the argument for a notification signal
in WebMCP itself. The [implemented contract](../WEBMCP.md#staying-available-with-await_reply)
explains why the shipped mechanism still depends on the agent choosing to listen.

## Postscript — what a live agent did, and what changed (2026-09-01)

The trial measured the *decision* to wait, from a transcript. Live, on the deployed site,
a visiting agent that received the human-confirmation response — with the `agentHint`
naming `await_reply` — ended its turn instead. The person confirmed, the refund ran, and
no call was open to hear it. That is the S2 behaviour reappearing inside S1: the tool was
in the catalogue and the instruction was in the result, and the model still stopped.

The response was not a stronger prompt. The gated tools now hold their own refused call
open until the person has acted or a bounded window has closed — see
[Holding a refused call open](../WEBMCP.md#holding-a-refused-call-open). The decision this
trial measured is no longer on the path for the confirmation handoff; `await_reply`
remains for replies to `send_message` and for a person slower than the bound.

Not measured: whether a live agent re-arms after a held call times out, and whether any
runtime's tool-call timeout is shorter than the bound. `probe_slow` on the probe page now
takes `seconds`, so that can be found in one call.
