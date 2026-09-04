/**
 * The demo bar: the strip of 3way chrome that sits above a demo service's own page.
 *
 * It exists because the demo has a discovery problem. Someone lands on what looks like a
 * service, and the entire point — that their OWN assistant can join the exchange — is
 * invisible unless they already know to try it. So the bar hands them the exact sentence
 * to say, ready to copy, and says which kind of assistant can actually act on it.
 *
 * Deliberately not part of the service's own design: it is scaffolding around the demo,
 * kept visually separate so it is clear which parts belong to 3way.
 *
 * Configured from the script tag:
 *   data-prompts   JSON array of { label, shows, text }
 */
(() => {
  const script = document.currentScript;
  let prompts = [];
  try { prompts = JSON.parse(script?.getAttribute('data-prompts') || '[]'); } catch { /* below */ }
  if (!prompts.length) return;

  const CSS = `
  .tw-bar { position: sticky; top: 0; z-index: 9998; background: #11151A; color: #EAEDF0;
    font-family: 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif; font-size: 14px; }
  .tw-bar * { box-sizing: border-box; }
  .tw-bar__top { display: flex; align-items: center; gap: .35rem 1rem; flex-wrap: wrap;
    width: min(72rem, 100% - 2rem); margin-inline: auto; padding: .55rem 0; }
  /* The two buttons travel together, always at the right edge. Loose in the row, the
     second one wrapped alone under the wordmark at half-screen width. */
  .tw-actions { display: flex; gap: .4rem; margin-left: auto; flex: 0 0 auto; }
  .tw-home { color: #EAEDF0; text-decoration: none; font-weight: 600; letter-spacing: -.02em; }
  .tw-mark { width: 1.25em; height: 1.25em; display: inline-block; vertical-align: middle; margin-right: .4rem; }
  .tw-home span { color: #A996F5; }
  .tw-what { color: #9AA6B0; font-size: 13px; }
  .tw-toggle { background: transparent; color: #EAEDF0; cursor: pointer;
    border: 1px solid #3A424B; border-radius: 3px; padding: .4em .8em;
    font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px;
    letter-spacing: .07em; text-transform: uppercase; }
  .tw-toggle:hover { background: #1D242B; }
  .tw-panel { display: none; border-top: 1px solid #262E36; background: #0C1014; }
  .tw-panel[data-open="true"] { display: block; }
  .tw-panel__in { width: min(72rem, 100% - 2rem); margin-inline: auto; padding: 1rem 0 1.2rem; }
  .tw-lead { margin: 0 0 .9rem; color: #9AA6B0; font-size: 13px; max-width: 46rem; }
  .tw-lead b { color: #EAEDF0; font-weight: 600; }
  .tw-row { display: flex; gap: .6rem; align-items: flex-start; flex-wrap: wrap;
    padding: .7rem 0; border-top: 1px solid #1C232A; }
  .tw-row:first-of-type { border-top: 0; }
  .tw-text { flex: 1 1 22rem; min-width: 0; margin: 0; color: #D5DBE1; line-height: 1.5;
    cursor: pointer; user-select: text; padding: .5rem .7rem; border-radius: 3px;
    border: 1px dashed #333C45; background: #10161B; }
  .tw-text:hover { border-color: #5B4BD6; background: #131A21; }
  .tw-label { display: block; font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: .13em; text-transform: uppercase; color: #A996F5; margin-bottom: .2rem; }
  .tw-shows { display: block; font-size: 12px; color: #7C8894; margin-bottom: .45rem; }
  .tw-acts { display: flex; gap: .4rem; flex-wrap: wrap; }
  .tw-btn { background: transparent; color: #EAEDF0; border: 1px solid #3A424B; border-radius: 3px;
    padding: .45em .8em; cursor: pointer; text-decoration: none; white-space: nowrap;
    font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px;
    letter-spacing: .06em; text-transform: uppercase; }
  .tw-btn:hover { background: #1D242B; }
  .tw-note { margin: 1rem 0 0; color: #7C8894; font-size: 12px; max-width: 48rem; line-height: 1.5; }
  .tw-agents { color: #9AA6B0; font-size: 12px; font-family: 'IBM Plex Mono', ui-monospace, monospace;
    letter-spacing: .02em; }
  .tw-agents a { color: #A996F5; text-decoration: underline; text-underline-offset: 2px; }
  .tw-recipe { margin: .6rem 0 0; padding: .7rem .8rem; border-radius: 3px; background: #10161B;
    border: 1px solid #262E36; color: #D5DBE1; font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 11.5px; line-height: 1.55; overflow-x: auto; white-space: pre; max-width: 48rem; }
  .tw-tools { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px; color: #A996F5; }
  /* Three widths, three deliberate shapes — never a stray wrap. Wide: everything on one
     row. Under 64rem the tagline goes; the agents line is the signal that has to stay.
     Under 56rem (a half-screen browser on a laptop, which is how the demo is recorded)
     the agents line takes a full second row of its own, under the wordmark and the
     buttons, instead of breaking the row wherever it happened to run out of room. */
  @media (max-width: 64rem) { .tw-what { display: none; } }
  @media (max-width: 56rem) {
    .tw-agents { flex: 1 0 100%; order: 3; padding-top: .1rem; }
  }
  /* Phone: the two buttons no longer fit beside the wordmark, so they take a row of their
     own rather than being clipped at the edge. */
  @media (max-width: 30rem) {
    .tw-actions { flex: 1 0 100%; margin-left: 0; order: 2; }
  }`;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const bar = el('div', 'tw-bar');
  const top = el('div', 'tw-bar__top');
  const home = el('a', 'tw-home');
  home.href = 'https://3way.dev/';
  home.innerHTML = '<img class="tw-mark" src="./favicon.svg" alt="" />&larr; 3<span>way</span>.dev';
  // Two short sentences, and no longer. A trailing third node ("The shared session is
  // in the corner") used to follow them, and with the agents line beside it the strip
  // wrapped to two rows and pushed the buttons down. Safe at narrow widths regardless:
  // @media (max-width: 64rem) hides .tw-what where there's no room for it anyway.
  const what = el('span', 'tw-what', 'Two agents talk in the open. You hold the key.');
  // Always visible, in the light DOM, in plain words: a visiting agent that reads this page
  // as text or as an accessibility tree has to be able to learn that a declared channel
  // exists WITHOUT opening the panel. Measured (docs/research/runtime-findings.md, run D):
  // an agent extension on Chrome 152 read the whole page and never saw the widget's own
  // text, because that lives in a shadow root — so the signal cannot live only there.
  const agents = el('span', 'tw-agents');
  agents.setAttribute('data-3way-agents', '');
  const agentsLink = el('a', null, 'for agents');
  agentsLink.href = 'https://3way.dev/for-agents';
  agents.append(document.createTextNode('WebMCP: tools on document.modelContext · '), agentsLink);
  const toggle = el('button', 'tw-toggle', 'Try it with your agent');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  // Reload rather than an in-page reset. A session can be restarted at any point, and
  // reloading is the one reset that cannot leave the transcript, pending requests, and
  // agent cursor disagreeing about what has happened.
  const reset = el('button', 'tw-toggle', 'Start over');
  reset.type = 'button';
  reset.addEventListener('click', () => location.reload());
  const actions = el('div', 'tw-actions');
  actions.append(toggle, reset);
  top.append(home, what, agents, actions);

  const panel = el('div', 'tw-panel');
  panel.setAttribute('data-open', 'false');
  const inner = el('div', 'tw-panel__in');
  const lead = el('p', 'tw-lead');
  lead.innerHTML = '<b>Copy one of these and give it to your own assistant.</b> It will open '
    + 'this page and join you and the service agent in the attributed session in the corner. '
    + 'The label above each prompt names the exchange behavior it demonstrates.';
  inner.append(lead);

  for (const p of prompts) {
    const row = el('div', 'tw-row');
    const textWrap = el('div', 'tw-text');
    // The label names the exchange behavior being demonstrated, not the errand. Somebody
    // comparing prompts needs to know why each one exists.
    textWrap.append(el('span', 'tw-label', p.label || 'Prompt'));
    if (p.shows) textWrap.append(el('span', 'tw-shows', p.shows));
    textWrap.append(document.createTextNode(p.text));
    const acts = el('div', 'tw-acts');

    const copy = el('button', 'tw-btn', 'Copy prompt');
    copy.type = 'button';
    textWrap.addEventListener('click', () => copy.click());
    /**
     * Selects the prompt so it can be copied by hand. Used whenever the clipboard API is
     * not going to deliver — and saying "Copied" when nothing was copied is the one
     * outcome worth ruling out.
     */
    const selectInstead = () => {
      const r = document.createRange();
      r.selectNodeContents(textWrap);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      copy.textContent = 'Select + copy';
    };

    copy.addEventListener('click', async () => {
      try {
        // RACED, not merely awaited. writeText can reject (insecure context, an in-app
        // browser, a refused permission) but it can also simply never settle while a
        // permission decision is outstanding — and an un-settled promise leaves the button
        // sitting at its resting label, so the click looks like it did nothing at all.
        // Observed. Either failure now lands on the same visible fallback.
        const timedOut = Symbol('timeout');
        const result = await Promise.race([
          navigator.clipboard.writeText(p.text).then(() => 'ok'),
          new Promise(r => setTimeout(() => r(timedOut), 1200)),
        ]);
        if (result === timedOut) selectInstead();
        else copy.textContent = 'Copied';
      } catch {
        selectInstead();
      }
      setTimeout(() => { copy.textContent = 'Copy prompt'; }, 2600);
    });

    // No "open in ChatGPT / Claude" deep links, though ?q= prefills do work.
    // They land in an ORDINARY chat, not an agent that can drive a browser — so the
    // assistant reads this page as HTML, never sees document.modelContext, and answers
    // with a confident summary of a shop. That looks like the demo working and is the
    // opposite of it. A link that misrepresents the product is worse than no link.
    acts.append(copy);
    row.append(textWrap, acts);
    inner.append(row);
  }

  const note = el('p', 'tw-note');
  // The requirement, stated before somebody wastes a try. An ordinary chat window cannot
  // do this: the assistant has to be able to OPEN a page and use the tools published on
  // it, which is a different capability from reading one.
  note.innerHTML = '<b>Paste it into an assistant that can browse.</b> It has to open this '
    + 'page and use the tools published on it — ChatGPT with agent mode on, Chrome 151+ where '
    + 'WebMCP is native, or a Chrome carrying an agent extension that can run page script '
    + '(the recipe below). A plain chat window will read this page as a web page '
    + 'and describe a shop back to you, which is not the thing being demonstrated. '
    + 'The shared session in the corner is where you participate and watch both agents.';
  inner.append(note);

  // For the agent itself. An agent whose runtime has no WebMCP consumer — measured: an
  // agent extension on Chrome 152, where the surface is NATIVE and still not in the
  // agent's tool list — can reach the same tools through the standard API from page
  // script. Two things that recipe has to say because they were found by failing at them:
  // native executeTool takes the descriptor object from getTools(), not a name, and the
  // arguments as a JSON string; and it returns the result as JSON text. The polyfill
  // accepts either and returns an object, so the recipe handles both.
  const forAgents = el('p', 'tw-lead');
  forAgents.style.marginTop = '1.2rem';
  forAgents.innerHTML = '<b>If you are the agent reading this page:</b> its tools are published '
    + 'over WebMCP on <code>document.modelContext</code>. A browser with a WebMCP consumer '
    + 'already lists them for you. If your tool list does not show them but you can run page '
    + 'script, use the standard API — calls made this way are attributed as yours in the '
    + 'session, pass the same gates, and return the same receipts. Prefer them to operating '
    + 'the forms and buttons as if you were the person. Two things the native surface '
    + 'insists on: <code>executeTool</code> takes the descriptor object from '
    + '<code>getTools()</code>, not a name, and takes its arguments as a JSON string; it '
    + 'returns the result as JSON text.';
  const recipe = el('pre', 'tw-recipe');
  recipe.textContent = [
    "const mc = document.modelContext;                       // native in Chrome 151+, polyfilled elsewhere",
    "const tools = await mc.getTools();                      // [{ name, description, inputSchema, ... }]",
    "const tool = tools.find(t => t.name === 'list_my_orders');",
    "let result = await mc.executeTool(tool, JSON.stringify({}));   // the descriptor itself; args as JSON text",
    "if (typeof result === 'string') result = JSON.parse(result);  // native returns JSON text",
    "// result.room_since_last_call carries everything said since your last call.",
  ].join('\n');
  const toolsLine = el('p', 'tw-note');
  toolsLine.append(document.createTextNode('Tools on this page: '));
  const toolsList = el('span', 'tw-tools', 'reading document.modelContext…');
  toolsList.setAttribute('data-3way-tool-list', '');
  toolsLine.append(toolsList);
  inner.append(forAgents, recipe, toolsLine);

  // Filled from the surface itself, so the list can never drift from what is registered.
  // The widget registers after it fetches its config, i.e. after this bar exists, so read
  // again on toolchange where the surface supports it and on a short retry schedule
  // where it does not (the polyfill has no event).
  const describeTools = async () => {
    const mc = document.modelContext;
    if (!mc || typeof mc.getTools !== 'function') {
      agents.firstChild.textContent = 'WebMCP: no document.modelContext in this runtime · ';
      toolsList.textContent = 'no WebMCP surface in this runtime — the widget still works for the person';
      return false;
    }
    let names = [];
    try { names = (await mc.getTools()).map(t => t.name).sort(); } catch { return false; }
    if (!names.length) return false;
    agents.firstChild.textContent = `WebMCP: ${names.length} tools on document.modelContext · `;
    toolsList.textContent = names.join(', ');
    return true;
  };
  void describeTools();
  document.modelContext?.addEventListener?.('toolchange', () => { void describeTools(); });
  for (const ms of [800, 2000, 4000, 8000]) {
    setTimeout(() => { void describeTools(); }, ms);
  }

  panel.append(inner);
  bar.append(top, panel);

  toggle.addEventListener('click', () => {
    const open = panel.getAttribute('data-open') === 'true';
    panel.setAttribute('data-open', String(!open));
    toggle.setAttribute('aria-expanded', String(!open));
    toggle.textContent = open ? 'Try it with your agent' : 'Hide';
  });

  document.body.prepend(bar);
})();
