// Your "Library" tab should look like this

/**
 * Memory Palace v0.1
 * Shared event memory for AI Dungeon characters.
 *
 * Built on the architecture of Inner Self by LewdLeah, and reusing several of
 * its techniques (JSON keys to hide cards from AID's matcher, fuzzy config card
 * lookup, tolerant block parsing). The data model is different: instead of each
 * character owning terminal stance strings, salient events get their own cards
 * and characters hold links to them carrying their own view of what happened.
 *
 * Two consequences worth knowing before you edit anything:
 *
 *  1. Pruning is script-side and salience-driven, NOT model-chosen. Salience
 *     lives on the event, so every witness forgets the same event at the same
 *     time. Uncorrelated forgetting destroys the whole point of a shared record.
 *     The model still steers what survives, but through recall: recalling an
 *     event raises its salience, silence lets it decay.
 *
 *  2. Event cards use REAL cue words in `keys`, so AID's own story-card matcher
 *     injects the one-line stub for free whenever those words appear. Memory Palace
 *     only has to do work for the uncued case.
 */
function MemoryPalace(hook) {
    "use strict";

    // ═══════════════════════════════════════════════════════════════════
    // CREATOR SETTINGS — edit these before publishing your scenario
    // ═══════════════════════════════════════════════════════════════════
    const S = {

    // List the first name of every NPC who should remember things:
    IMPORTANT_SCENARIO_CHARACTERS: ""
    // (comma separated inside the "" like so: "Leah, Bram, Cass")
    ,
    // Is Memory Palace already enabled when the adventure begins?
    IS_ENABLED_BY_DEFAULT: true
    // (true or false)
    ,
    // Is the adventure written in 1st, 2nd, or 3rd person?
    FIRST_SECOND_OR_THIRD_PERSON_POV: 2
    // (1, 2, or 3)
    ,
    // What percentage of "Recent Story" context may a character's mind occupy?
    PERCENTAGE_OF_RECENT_STORY_USED_FOR_MINDS: 30
    // (5 to 95)
    ,
    // How many actions back should Memory Palace look for character name triggers?
    NUMBER_OF_ACTIONS_TO_LOOK_BACK_FOR_TRIGGERS: 5
    // (1 to 250)
    ,
    // Symbol marking which character is currently remembering:
    ACTIVE_CHARACTER_VISUAL_INDICATOR_SYMBOL: "🕮"
    // (any text/emoji inside the "" or leave empty)
    ,
    // What percentage of eligible turns should offer a memory operation?
    MEMORY_OPERATION_CHANCE_PER_TURN: 60
    // (0 to 100)
    ,
    // Is that chance halved on Do/Say/Story turns, to protect player agency?
    IS_CHANCE_HALVED_FOR_DO_SAY_STORY: true
    // (true or false)
    ,
    // How many existing event titles are offered as a menu each turn?
    // Simulation says convergence saturates around 12; more just costs budget.
    EVENT_MENU_SIZE: 12
    // (0 to 30)
    ,
    // Minimum turns between recording brand new events. This is the main
    // defence against the model minting duplicates of events it already has.
    TURNS_BETWEEN_NEW_EVENT_RECORDS: 25
    // (0 to 500)
    ,
    // How many full event bodies may be resolved into context per turn?
    EVENT_BODIES_RESOLVED_PER_TURN: 1
    // (0 to 3)
    ,
    // Show memory operations inline in the story text, for debugging?
    IS_DEBUG_MODE_ENABLED_BY_DEFAULT: false
    // (true or false)
    ,
    // Pin the config card near the top of the player's card list?
    IS_CONFIG_CARD_PINNED_BY_DEFAULT: false
    // (true or false)
    ,
    };
    // ═══════════════════════════════════════════════════════════════════

    const VERSION = "v0.1";

    // Bail out if the AID sandbox is not what we expect.
    if (
        !globalThis.state || (typeof state !== "object") || Array.isArray(state)
        || !globalThis.info || (typeof info !== "object")
        || !Array.isArray(globalThis.storyCards)
        || (typeof addStoryCard !== "function")
        || !Array.isArray(globalThis.history)
        || (typeof text !== "string")
    ) {
        globalThis.text ||= " ";
        return;
    }

    // ───────────────────────────────────────────────── persistent state
    const MP = state.MemoryPalace ??= {};
    MP.agent ??= "";          // who is on stage (set by context, read by output)
    MP.staged ??= "";         // "" = no op offered this turn
    MP.turn ??= 0;            // Memory Palace's own turn counter
    MP.lastRecord ??= -9999;  // turn of the most recent new-event record
    MP.nextId ??= 1;          // event id allocator
    MP.hash ??= "";           // retry detection
    MP.menu ??= [];           // slugs offered to the model this turn

    // ───────────────────────────────────────────────── small helpers
    const clampInt = (v, lo, hi, dflt) => {
        const n = (typeof v === "string") ? parseInt(v.replace(/[^0-9-]/g, ""), 10) : v;
        return Number.isFinite(n) ? Math.min(Math.max(lo, Math.round(n)), hi) : dflt;
    };

    /** Normalize any model-written identifier into a safe snake_case slug. */
    const slugify = (s = "") => (String(s)
        .trim()
        .replace(/[.'`´‘’"]+/g, "")
        .replace(/([a-z0-9])([A-Z])/g, (_, a, b) => `${a}_${b}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/__+/g, "_")
        .replace(/(?:^_|_$)/g, "")
        // Models habitually wrap names in the vocabulary of the prompt:
        // thought_x, x_memory, event_y. Strip it before it eats a slug slot.
        .replace(/^(?:thoughts?|memory|memories|event|events|note|notes|record|recall|key)_/, "")
        .replace(/_(?:thoughts?|thinking|memory|memories|event|note|key)$/, "")
        .replace(/(?:^_|_$)/g, "")
        .split("_").slice(0, 5).join("_")
    );

    /** One clean sentence out of whatever the model produced. */
    const oneSentence = (s = "") => (String(s)
        .replace(/[#*~•·]+/g, "")
        .replace(/^[\s"'`«»„“”´‘’]+|[\s"'`«»„“”´‘’]+$/g, "")
        .replace(/\s+/g, " ")
        .split("\n")[0]
        .trim()
        .slice(0, 240)
    );

    const parseJSON = (str = "") => {
        try {
            const o = JSON.parse(str);
            return (o && (typeof o === "object") && !Array.isArray(o)) ? o : {};
        } catch { return {}; }
    };

    /** Possessive form that survives names ending in s. */
    const owns = (n = "") => `${n}${n.toLowerCase().endsWith("s") ? "'" : "'s"}`;

    const historyHash = () => {
        let n = 0;
        const s = JSON.stringify(history.slice(-50));
        for (let i = 0; i < s.length; i++) n = ((31 * n) + s.charCodeAt(i)) | 0;
        return n.toString(16);
    };

    const prevAction = () => history.findLast(a =>
        !/^[\u200B-\u200D\s]*$/.test(a?.text ?? a?.rawText ?? "")
    );

    /** Text of the last `n` meaningful actions, lowercased. */
    const recentText = (n = 5) => {
        const out = [];
        for (let i = history.length - 1; (-1 < i) && (out.length < n); i--) {
            const t = history[i]?.text ?? history[i]?.rawText ?? "";
            if (/^[\u200B-\u200D\s]*$/.test(t)) continue;
            out.push(t);
        }
        return out.join(" ").toLowerCase();
    };

    /** Whole-word, case-insensitive containment without regex construction. */
    const mentions = (haystackLower = "", needle = "") => {
        const n = needle.toLowerCase();
        if (n === "") return false;
        for (let p = haystackLower.indexOf(n); p !== -1; p = haystackLower.indexOf(n, p + 1)) {
            const before = (0 < p) ? haystackLower.charCodeAt(p - 1) : 0;
            const after = ((p + n.length) < haystackLower.length)
                ? haystackLower.charCodeAt(p + n.length) : 0;
            if (((before < 97) || (122 < before)) && ((after < 97) || (122 < after))) return true;
        }
        return false;
    };

    // ═══════════════════════════════════════════════════════════════════
    // EVENT CARDS
    //
    // title       "⌛ lamp_went_out"      (slug, visually grouped)
    // keys        "lamp, shutter, Bram"  REAL cue words — AID injects `entry`
    //                                    for free when these appear in the story
    // entry       one-line third-person stub (the free injection)
    // description script-owned metadata + full body, hand editable:
    //
    //     memorypalace: event
    //     salience: 60
    //     turn: 42
    //     recalls: 2
    //     witnesses: Leah, Bram
    //     ---
    //     The lamp went out during the argument and nobody moved to relight it.
    // ═══════════════════════════════════════════════════════════════════
    const EVENT_PREFIX = "⌛";

    const parseEvent = (card) => {
        if (!card || (typeof card.description !== "string")) return null;
        if (!/^\s*memorypalace\s*:\s*event/i.test(card.description)) return null;
        const [head, ...rest] = card.description.split(/\n\s*---\s*\n/);
        const meta = {};
        for (const line of head.split("\n")) {
            const i = line.indexOf(":");
            if (i === -1) continue;
            meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        return {
            card,
            slug: (card.title || "").replace(EVENT_PREFIX, "").trim(),
            stub: (card.entry || "").trim(),
            body: rest.join("\n---\n").trim(),
            salience: clampInt(meta.salience, 0, 100, 60),
            turn: clampInt(meta.turn, 0, 1e9, 0),
            recalls: clampInt(meta.recalls, 0, 9999, 0),
            witnesses: (meta.witnesses || "").split(",").map(s => s.trim()).filter(Boolean),
        };
    };

    const writeEvent = (ev) => {
        ev.card.title = `${EVENT_PREFIX} ${ev.slug}`;
        ev.card.type = "Event";
        ev.card.entry = ev.stub;
        ev.card.description = [
            "memorypalace: event",
            `salience: ${clampInt(ev.salience, 0, 100, 60)}`,
            `turn: ${ev.turn}`,
            `recalls: ${ev.recalls}`,
            `witnesses: ${ev.witnesses.join(", ")}`,
            "---",
            ev.body,
        ].join("\n");
        return ev;
    };

    /** All event cards, parsed. */
    const allEvents = () => {
        const out = [];
        for (const card of storyCards) {
            const ev = parseEvent(card);
            if (ev && (ev.slug !== "")) out.push(ev);
        }
        return out;
    };

    /**
     * Effective salience: base, lifted by how often anyone has recalled it,
     * eroded by how long since anyone did. Because this is a property of the
     * EVENT and not of any one character, all witnesses prune in step — which
     * is the whole reason a shared record is worth having.
     */
    const weigh = (ev, now) => (
        ev.salience + (8 * ev.recalls) - Math.floor(Math.max(0, now - ev.turn) / 25)
    );

    /**
     * Cue words for AID's own matcher. These decide when the event's stub gets
     * injected for free, so they need to be distinctive: proper nouns first,
     * then long content words. Common connectives make terrible cues because
     * they fire on almost every turn.
     *
     * Witness names are deliberately EXCLUDED. A character's own name is the
     * most frequent token in any scene they are in, so keying their events on
     * it fires every one of them at once — in a one-NPC scenario that is the
     * entire back catalogue, every turn. Witnesses are still recorded in the
     * card's notes, where they rank the menu; they just make terrible cues.
     */
    const STOPWORDS = new Set([
        "about", "above", "after", "again", "against", "almost", "already", "although",
        "another", "anything", "because", "before", "behind", "being", "below", "between",
        "could", "during", "enough", "every", "everything", "further", "having", "however",
        "instead", "might", "never", "nobody", "nothing", "other", "perhaps", "rather",
        "should", "since", "someone", "something", "still", "their", "there", "these",
        "those", "though", "through", "until", "where", "which", "while", "whole",
        "without", "would", "yourself",
    ]);
    const cueWords = (body = "", witnesses = []) => {
        const seen = new Set(witnesses.map(w => w.toLowerCase()));
        const proper = [];
        const content = [];
        const words = body.split(/[^A-Za-z']+/).filter(Boolean);
        words.forEach((w, i) => {
            const low = w.toLowerCase();
            if (seen.has(low) || STOPWORDS.has(low)) return;
            // Capitalized mid-sentence is a decent proper-noun heuristic.
            if ((0 < i) && (w[0] === w[0].toUpperCase()) && (w[0] !== w[0].toLowerCase())) {
                seen.add(low); proper.push(w);
            } else if (6 <= w.length) {
                seen.add(low); content.push(low);
            }
        });
        return [...proper, ...content].slice(0, 8).join(", ");
    };

    // ═══════════════════════════════════════════════════════════════════
    // MIND CARDS
    //
    // keys        {"memorypalace":"mind","name":"Leah"}  JSON, so AID's matcher
    //                                                 can never trigger it
    // entry       operation log (player-facing)
    // description the mind itself, hand editable:
    //
    //     who_i_am: I keep this house because my mother kept it.
    //     lamp_went_out: → I still think Bram put it out on purpose.
    //
    // A value beginning with → marks the line as a link, and the key is then the
    // slug of an event card. Everything else is a plain standing thought.
    // ═══════════════════════════════════════════════════════════════════
    const LINK_MARK = "→";
    // A link whose value is this marker means "I was there but have not put a
    // view to it yet". The menu ranks these first so the character fills them in.
    const NO_VIEW = "?";

    const findMind = (name) => {
        for (const card of storyCards) {
            if ((typeof card.keys === "string") && card.keys.includes("\"mind\"")) {
                const m = parseJSON(card.keys);
                if ((m.memorypalace === "mind") && (m.name === name)) return card;
            }
        }
        return null;
    };

    const makeMind = (name) => addStoryCard(
        JSON.stringify({ memorypalace: "mind", name }),
        `// ${name} remembers nothing yet`,
        "Mind",
        name,
        "",
        { returnCard: true }
    );

    const getMind = (name) => findMind(name) || makeMind(name);

    /** Parse a mind card into [{key, value, link}] preserving order. */
    const readMind = (card) => {
        const out = [];
        for (const line of String(card.description || "").split("\n")) {
            const clean = line.trim();
            if (clean === "") continue;
            const i = clean.indexOf(":");
            if (i === -1) continue;
            const key = slugify(clean.slice(0, i));
            let value = clean.slice(i + 1).trim();
            if (key === "") continue;
            const link = value.startsWith(LINK_MARK) || value.startsWith("->");
            if (link) value = value.replace(/^(?:→|->)\s*/, "").trim();
            if (value === "") continue;
            out.push({ key, value, link });
        }
        return out;
    };

    const writeMind = (card, entries) => {
        card.description = entries
            .map(e => `${e.key}: ${e.link ? `${LINK_MARK} ` : ""}${e.value}`)
            .join("\n");
    };

    /** Append a line to the mind card's operation log, keeping it bounded. */
    const logOp = (card, line) => {
        const lines = String(card.entry || "")
            .split("\n")
            .filter(l => l.trim() !== "" && !l.startsWith("// ") || l.startsWith("// turn"));
        lines.push(line);
        card.entry = lines.slice(-14).join("\n");
    };

    // ═══════════════════════════════════════════════════════════════════
    // CONFIG CARD
    // ═══════════════════════════════════════════════════════════════════
    const CONFIG_TITLE = "Configure Memory Palace";
    const CONFIG_KEYS = "\u200Bmemory-palace-config";

    const SETTINGS = [
        ["Enable Memory Palace", "allow", "bool", S.IS_ENABLED_BY_DEFAULT],
        ["Adventure in 1st, 2nd, or 3rd person", "pov", [1, 3], S.FIRST_SECOND_OR_THIRD_PERSON_POV],
        ["Max mind size relative to story context", "percent", [5, 95], S.PERCENTAGE_OF_RECENT_STORY_USED_FOR_MINDS],
        ["Recent turns searched for name triggers", "distance", [1, 250], S.NUMBER_OF_ACTIONS_TO_LOOK_BACK_FOR_TRIGGERS],
        ["Visual indicator of current character", "indicator", "text", S.ACTIVE_CHARACTER_VISUAL_INDICATOR_SYMBOL],
        ["Memory operation chance per turn", "chance", [0, 100], S.MEMORY_OPERATION_CHANCE_PER_TURN],
        ["Half chance for Do/Say/Story", "half", "bool", S.IS_CHANCE_HALVED_FOR_DO_SAY_STORY],
        ["Event menu size", "menuSize", [0, 30], S.EVENT_MENU_SIZE],
        ["Turns between new event records", "cooldown", [0, 500], S.TURNS_BETWEEN_NEW_EVENT_RECORDS],
        ["Event bodies resolved per turn", "resolve", [0, 3], S.EVENT_BODIES_RESOLVED_PER_TURN],
        ["Enable debug mode", "debug", "bool", S.IS_DEBUG_MODE_ENABLED_BY_DEFAULT],
        ["Pin this config card near the top", "pin", "bool", S.IS_CONFIG_CARD_PINNED_BY_DEFAULT],
    ];

    const simplify = (s = "") => s.toLowerCase().replace(/[^a-z]+/g, "");

    /** Bounded-edit-distance title match, so a player typo doesn't orphan the card. */
    const looksLikeConfig = (title = "") => {
        const cur = simplify(title);
        const tgt = simplify(CONFIG_TITLE);
        let mistakes = 0, t = 0, c = 0;
        while ((t < tgt.length) && (c < cur.length)) {
            if (cur[c] === tgt[t]) { t++; c++; continue; }
            if (2 <= mistakes) return false;
            mistakes++;
            (cur[c + 1] === tgt[t]) ? c++ : (cur[c] === tgt[t + 1]) ? t++ : (t++, c++);
        }
        return ((mistakes + (tgt.length - t) + (cur.length - c)) <= 2);
    };

    const readConfig = () => {
        const cfg = { card: null, agents: [] };
        const pending = new Set();

        // Creator-declared names.
        for (const n of String(S.IMPORTANT_SCENARIO_CHARACTERS).split(",")) {
            const name = n.trim();
            if (name !== "") pending.add(name);
        }

        for (let i = storyCards.length - 1; -1 < i; i--) {
            const card = storyCards[i];
            if (typeof card.title !== "string") { card.title = ""; continue; }
            // "@Name" cards are the mobile-friendly way to declare an NPC.
            if (card.title.startsWith("@")) {
                const name = card.title.replace(/^[@\s]*/, "").trim();
                if (name !== "") { card.title = name; pending.add(name); }
                continue;
            }
            if (!looksLikeConfig(card.title)) continue;
            if (cfg.card === null) cfg.card = card;
            else if (typeof removeStoryCard === "function") removeStoryCard(i);
            else storyCards.splice(i, 1);
        }

        const defaults = {};
        for (const [label, key, kind, dflt] of SETTINGS) {
            defaults[key] = (kind === "bool") ? (dflt === true)
                : (kind === "text") ? String(dflt ?? "")
                : clampInt(dflt, kind[0], kind[1], kind[0]);
        }

        if (cfg.card === null) {
            cfg.card = addStoryCard(
                CONFIG_KEYS,
                SETTINGS.map(([label, key, kind]) => `> ${label}: ${
                    (kind === "text") ? `"${defaults[key]}"` : defaults[key]
                }`).join("\n"),
                "Memory Palace",
                CONFIG_TITLE,
                [
                    "> Write the first name of every remembering character on its own line",
                    "> at the very bottom of this notes section, highest priority first.",
                    "",
                    ...[...pending],
                ].join("\n"),
                { returnCard: true }
            );
        }

        // Read settings back out of the entry.
        const found = {};
        for (const block of String(cfg.card.entry || "").split(/\s*>[\s>]*/)) {
            const i = block.indexOf(":");
            if (i === -1) continue;
            found[simplify(block.slice(0, i))] = block.slice(i + 1).trim();
        }
        for (const [label, key, kind] of SETTINGS) {
            const raw = found[simplify(label)];
            if (raw === undefined) { cfg[key] = defaults[key]; continue; }
            cfg[key] = (kind === "bool") ? !/^\s*false\s*$/i.test(raw)
                : (kind === "text") ? raw.replace(/^["'\s]+|["'\s]+$/g, "")
                : clampInt(raw, kind[0], kind[1], defaults[key]);
        }

        // Agent names live at the bottom of the notes, one per line.
        for (const line of String(cfg.card.description || "").split("\n")) {
            const name = line.trim();
            if ((name === "") || name.startsWith(">")) continue;
            pending.add(name.replace(/[,\u200B-\u200D]/g, "").trim());
        }
        cfg.agents = [...pending].filter(Boolean);
        return cfg;
    };

    // ═══════════════════════════════════════════════════════════════════
    // CONTEXT HOOK
    // ═══════════════════════════════════════════════════════════════════
    if ((hook === "context") || Number.isInteger(info.maxChars)) {
        globalThis.stop ??= false;
        const limit = Math.max(Math.min(text.length, info.maxChars ?? 1e9) - 10, 4000);
        const cfg = readConfig();
        MP.agent = "";
        MP.staged = "";
        MP.menu = [];

        if (cfg.pin) {
            const i = storyCards.indexOf(cfg.card);
            if (0 < i) { storyCards.splice(i, 1); storyCards.unshift(cfg.card); }
        }

        // Strip our own indicator from every card title before re-applying it.
        for (const card of storyCards) {
            if ((typeof card.title === "string") && card.title.includes("\u200B")
                && !card.title.startsWith(EVENT_PREFIX)) {
                card.title = card.title.slice(card.title.indexOf("\u200B") + 1).trim();
            }
        }

        if (!cfg.allow || (cfg.agents.length === 0)) { text ||= " "; return; }

        MP.turn++;

        // ── who is on stage ────────────────────────────────────────────
        // Same idea as Inner Self: scan back a few actions for names, and when
        // several match, draw with weights n, n-1, ... so config order is a soft
        // priority rather than a hard one.
        const hits = [];
        {
            let remaining = cfg.distance;
            for (let i = history.length - 1; (-1 < i) && (0 < remaining) && (hits.length === 0); i--) {
                const t = history[i]?.text ?? history[i]?.rawText ?? "";
                if (/^[\u200B-\u200D\s]*$/.test(t)) continue;
                remaining--;
                const low = t.toLowerCase();
                for (const name of cfg.agents) if (mentions(low, name)) hits.push(name);
            }
        }
        if (hits.length === 0) { text ||= " "; return; }

        {
            const n = hits.length;
            let r = Math.random() * ((n * (n + 1)) / 2);
            for (let i = 0; i < n; i++) { r -= (n - i); if (r < 0) { MP.agent = hits[i]; break; } }
        }
        const agentName = MP.agent;

        const mindCard = getMind(agentName);
        if (cfg.indicator !== "") {
            mindCard.title = `${cfg.indicator}\u200B ${agentName}`;
        }

        // ── budget ─────────────────────────────────────────────────────
        const NEEDLE = "Recent Story:";
        const storyStart = text.indexOf(NEEDLE);
        const storyLen = (storyStart === -1) ? text.length : (text.length - storyStart);
        const budget = Math.max(600, Math.floor((cfg.percent / 100) * storyLen));

        const events = allEvents();
        const byslug = new Map(events.map(e => [e.slug, e]));
        const entries = readMind(mindCard);

        // ── prune, script-side, by event salience ──────────────────────
        // Deterministic and shared: every witness drops the same event on the
        // same turn, which is what keeps a shared record actually shared.
        const weightOf = (e) => e.link
            ? (byslug.has(e.key) ? weigh(byslug.get(e.key), MP.turn) : -1000)
            : 50;
        const lineCost = (e) => e.key.length + e.value.length + 6;
        let total = entries.reduce((s, e) => s + lineCost(e), 0);
        const menuCost = cfg.menuSize * 22;
        while ((budget - menuCost < total) && (1 < entries.length)) {
            let worst = 0;
            for (let i = 1; i < entries.length; i++) {
                if (weightOf(entries[i]) < weightOf(entries[worst])) worst = i;
            }
            total -= lineCost(entries[worst]);
            const [dropped] = entries.splice(worst, 1);
            logOp(mindCard, `// ${agentName} lets go of "${dropped.key}"`);
        }
        writeMind(mindCard, entries);

        // ── build the mind block ───────────────────────────────────────
        // Events this character links to at all, and those they have actually
        // formed a view about.
        const linked = new Set(entries.filter(e => e.link).map(e => e.key));
        const viewed = new Set(entries.filter(e => e.link && (e.value !== NO_VIEW)).map(e => e.key));
        const storyLower = recentText(cfg.distance);

        // Resolve a full body or two: prefer events whose cue words are live in
        // the recent story, then whichever the character weighs most heavily.
        const resolvable = entries
            .filter(e => e.link && byslug.has(e.key))
            .map(e => {
                const ev = byslug.get(e.key);
                const cued = String(ev.card.keys || "")
                    .split(",").map(s => s.trim()).filter(s => 2 < s.length)
                    .some(k => mentions(storyLower, k));
                return { entry: e, ev, score: (cued ? 1000 : 0) + weigh(ev, MP.turn) };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, cfg.resolve);
        const resolvedSlugs = new Set(resolvable.map(r => r.ev.slug));

        const mindLines = entries.map(e => {
            if (!e.link) return `- ${e.key}: ${e.value}`;
            const ev = byslug.get(e.key);
            if (!ev) return `- ${e.key}: ${e.value}`;
            if (e.value === NO_VIEW) {
                return `- [${e.key}] ${ev.stub}\n  (${agentName} has not yet put a view to this)`;
            }
            return resolvedSlugs.has(e.key)
                ? `- [${e.key}] what happened: ${ev.body || ev.stub}\n  ${owns(agentName)} view: ${e.value}`
                : `- [${e.key}] ${e.value}`;
        });

        const mindBlock = (mindLines.length === 0) ? "" : (
            `\n\n# ${owns(agentName)} memory: [\n${mindLines.join("\n")}\n]\n\n`
        );

        // ── the event menu ─────────────────────────────────────────────
        // The model can only link to an event it can see. Rank by "was I there
        // and have I not recorded my view yet", then by weight. Simulation says
        // this is the difference between ~79% and 0% convergence between
        // witnesses, and that it saturates around a dozen titles.
        const menu = events
            .filter(ev => !resolvedSlugs.has(ev.slug))
            .map(ev => ({
                ev,
                rank: (ev.witnesses.includes(agentName) && !viewed.has(ev.slug) ? 2000 : 0)
                    + (ev.witnesses.includes(agentName) ? 500 : 0)
                    + weigh(ev, MP.turn),
            }))
            .sort((a, b) => b.rank - a.rank)
            .slice(0, cfg.menuSize)
            .map(x => x.ev);
        MP.menu = menu.map(ev => ev.slug);

        // ── should we ask for an operation at all? ─────────────────────
        const halve = cfg.half && ["do", "say", "story"].includes(prevAction()?.type);
        const offer = (MP.hash !== historyHash())
            && (Math.random() < (cfg.chance / (halve ? 200 : 100)));

        // Inner Self threads the player's name through every prompt because its
        // job is positioning an NPC relative to the player. Memory Palace's prompts
        // are about events and the characters who witnessed them, so point of
        // view alone carries the weight and no name setting is needed.
        const POV = [
            {
                frame: "The story is written in the first person, from the player character's point of view.",
                prose: "first person present tense",
            },
            {
                frame: "The story addresses the player character directly as \"you\".",
                prose: "second person present tense (\"you\")",
            },
            {
                frame: "The story is written in the third person, following the player character.",
                prose: "third person",
            },
        ][clampInt(cfg.pov, 1, 3, 2) - 1];
        const canRecord = (cfg.cooldown <= (MP.turn - MP.lastRecord));

        const directive = [
            "<s>",
            "# OPERATING ENVIRONMENT",
            `- ${POV.frame}`,
            `- ${agentName} is a character in the story who remembers past events and holds a personal view of them.`,
            `- ${agentName} maintains own memory using the provided operations.`,
            `- Shared events are recorded once; each character keeps their own view of what it meant.`,
            "</s>",
        ].join("\n");

        if (!offer) {
            text = `${directive}${mindBlock}${text.trim()} `;
        } else {
            MP.staged = agentName;
            const menuBlock = (menu.length === 0) ? "" : [
                "",
                "## EVENTS ALREADY ON RECORD (use these exact names)",
                ...menu.map(ev => `- ${ev.slug}: ${ev.stub}`),
                "",
            ].join("\n");

            const forms = [
                `1) **Record ${owns(agentName)} view of an event already on record:**`,
                "   (recall event_name = `One sentence, first person, what it means to me.`)",
                "",
                ...(canRecord ? [
                    "2) **Record a brand new event that just happened:**",
                    "   (record new_event_name = `One sentence, plain third person, what happened.`)",
                    "",
                ] : []),
                `${canRecord ? "3" : "2"}) **Store a standing thought that is not about any one event:**`,
                "   (thought_name = `One sentence, first person.`)",
            ];

            const task = [
                "<s>",
                "# STRICT OUTPUT FORMAT",
                "",
                "You must output exactly one parenthetical operation, then the story.",
                "",
                menuBlock,
                "## THE OPERATION (REQUIRED)",
                "Choose ONE of these forms and start your output with it immediately:",
                "",
                ...forms,
                "",
                "Rules:",
                "- Names use snake_case: letters and underscores only, four words at most.",
                "- An event name and its sentence belong to everyone who was there, so",
                "  both must be neutral: name the moment, not the person noticing it, and",
                "  state only what happened, with no interpretation of what it meant.",
                `- If the moment already appears in the list above, use \`recall\` with that exact name.${
                    canRecord ? " Only use `record` for something genuinely new." : " `record` is unavailable this turn."
                }`,
                `- A \`recall\` sentence is ${owns(agentName)} own first person view, and may disagree with the record.`,
                "- One operation only. Never invent other forms. Never use extra parentheses.",
                "",
                "## THE STORY (REQUIRED)",
                "- After the closing parenthesis write one space, then continue the story.",
                `- Continue in ${POV.prose}, several sentences of new prose.`,
                "- The story must be the majority of the output.",
                "",
                "## EXACT SHAPE",
                "(recall some_event = `My own short view of it.`) The story continues...",
                "</s>",
            ].join("\n");

            text = `${directive}${mindBlock}${text.trim()}\n\n${task}\n\n`;
        }

        // ── truncate to fit ────────────────────────────────────────────
        if (limit < text.length) {
            const start = text.indexOf(NEEDLE);
            const excess = text.length - limit;
            if ((start !== -1) && (2000 < storyLen)) {
                const from = start + NEEDLE.length;
                const remove = Math.min(excess, Math.max(0, storyLen - 2000));
                text = `${text.slice(0, from)}${text.slice(from + remove)}`;
            }
            if (limit < text.length) text = text.slice(text.length - limit);
        }
        text = text.trimStart() || " ";
        return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // INPUT HOOK
    // ═══════════════════════════════════════════════════════════════════
    if (hook === "input") {
        text = (history.length === 0) ? `${text.trimEnd()}\n\n` : (text || "\u200B");
        return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // OUTPUT HOOK
    // ═══════════════════════════════════════════════════════════════════
    {
        const cfg = readConfig();
        const staged = MP.staged;
        const agentName = MP.agent;
        MP.staged = "";
        MP.agent = "";
        MP.hash = historyHash();

        if (!cfg.allow) { text ||= "\u200B"; return; }
        if ((3000 < text.length) || text.includes(">>>")) { text ||= "\u200B"; return; }

        // Models sometimes drop the opening bracket entirely.
        if (!/[()\[\]{}]/.test(text) && /^\s*(?:recall|record|remember|delete|forget)\s+\w+/i.test(text)) {
            text = `(${text.trimStart()}`;
        }

        // ── pull out the first bracketed block, repairing as needed ────
        let block = null;
        for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
            const start = text.indexOf(open);
            if (start === -1) continue;
            let end = text.indexOf(close, start);
            if (end === -1) {
                // Close it after the backtick-or-quote that ends the sentence,
                // else at the end of the first line.
                const rest = text.slice(start);
                const m = rest.match(/[.?!][`'"’]|\n/);
                const at = start + (m ? m.index + m[0].length : rest.length);
                text = `${text.slice(0, at)}${close}${text.slice(at)}`;
                end = at;
            }
            block = text.slice(start, end + 1);
            // Remove it from the player-visible prose.
            text = `${text.slice(0, start)}${cfg.debug ? `${block} ` : ""}${text.slice(end + 1)}`;
            break;
        }
        text = text.replace(/^[\s'`´‘’]+/, "").replace(/\n{3,}/g, "\n\n");
        if (text.trim() === "") text = "\u200B";

        if ((block === null) || (staged === "") || (agentName === "")) return;

        const inner = block.slice(1, -1).trim().replace(/==+/g, "=");
        const mindCard = getMind(agentName);
        const entries = readMind(mindCard);
        const events = allEvents();
        const byslug = new Map(events.map(e => [e.slug, e]));

        const upsert = (key, value, link) => {
            const found = entries.find(e => e.key === key);
            if (found) { found.value = value; found.link = link; }
            else entries.push({ key, value, link });
        };

        // ── delete ─────────────────────────────────────────────────────
        const del = inner.match(/^(?:del(?:ete)?|forget|remove)\s*[:=]?\s*(.+)$/i);
        if (del) {
            const key = slugify(del[1]);
            const i = entries.findIndex(e => e.key === key);
            if (-1 < i) {
                entries.splice(i, 1);
                logOp(mindCard, `// ${agentName} forgets "${key}"`);
                writeMind(mindCard, entries);
            }
            return;
        }

        // ── recall / record / plain thought ────────────────────────────
        const op = inner.match(/^(recall|remember|record|note|log)?\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*[=:]\s*([\s\S]+)$/i);
        if (!op) return;

        const verb = (op[1] || "").toLowerCase();
        const key = slugify(op[2]);
        const value = oneSentence(op[3]);

        // Reject placeholder names lifted straight out of the prompt.
        if ((key === "") || (value === "") || !value.includes(" ")
            || ["event_name", "new_event_name", "thought_name", "some_event"].includes(key)) return;

        /**
         * Resolve a requested event name against what is actually on record.
         * The model sees canonical names on the menu, but it also paraphrases,
         * drops words, and re-derives names from its own earlier prose. An
         * unresolved recall is silently lost, so try harder than exact match.
         */
        const resolveEvent = (want) => {
            if (byslug.has(want)) return byslug.get(want);
            const parts = want.split("_").filter(w => 2 < w.length);
            let best = null, bestScore = 0;
            for (const ev of events) {
                const theirs = ev.slug.split("_").filter(w => 2 < w.length);
                if ((parts.length === 0) || (theirs.length === 0)) continue;
                let shared = 0;
                for (const w of parts) if (theirs.includes(w)) shared++;
                // Needs to cover most of one side or the other to count.
                const score = shared / Math.min(parts.length, theirs.length);
                if ((0.99 <= score) && (bestScore < score + shared / 100)) {
                    best = ev; bestScore = score + shared / 100;
                }
            }
            return best;
        };

        const isRecall = /^(recall|remember)$/.test(verb) || (resolveEvent(key) !== null);
        const isRecord = /^(record|note|log)$/.test(verb) && !byslug.has(key);

        if (isRecall) {
            const ev = resolveEvent(key);
            if (!ev) return; // asked to recall something that does not exist
            const slug = ev.slug;
            const fresh = !entries.some(e => e.link && (e.key === slug));
            // A "recall" that just restates the record is not a personal view.
            // This happens constantly when the model tries to `record` something
            // already on the books: keep the link, drop the parroted text, and
            // let the menu ask them for an actual view next time.
            const parroted = (() => {
                const a = value.toLowerCase().replace(/[^a-z ]/g, "");
                const b = `${ev.stub} ${ev.body}`.toLowerCase().replace(/[^a-z ]/g, "");
                return (20 < a.length) && b.includes(a.slice(0, Math.min(40, a.length)));
            })();
            const existing = entries.find(e => e.link && (e.key === slug));
            if (parroted) {
                if (!existing) upsert(slug, NO_VIEW, true);
            } else {
                upsert(slug, value, true);
            }
            // Recall is how the model votes on what matters. Salience lives on
            // the event, so this vote is shared by every witness.
            ev.recalls += 1;
            if (!ev.witnesses.includes(agentName)) ev.witnesses.push(agentName);
            writeEvent(ev);
            logOp(mindCard, parroted
                ? `${agentName} was there for ${slug}`
                : `${agentName} ${fresh ? "recalls" : "revises"} ${slug}: ${value}`);
            writeMind(mindCard, entries);
            return;
        }

        if (isRecord) {
            if ((MP.turn - MP.lastRecord) < cfg.cooldown) return; // cooldown, silently
            // "norman_sees_stalled_site" is a record only Norman can own. Strip the
            // observer so other witnesses can link to the same moment naturally.
            let slug = key;
            for (const n of cfg.agents) {
                const pre = `${slugify(n)}_`;
                if (slug.startsWith(pre) && (2 <= slug.slice(pre.length).split("_").length)) {
                    slug = slug.slice(pre.length);
                    break;
                }
            }
            // ...and a leading perception verb, for the same reason: "sees" is
            // whose-eyes framing, and the moment outlives the witness.
            slug = slug.replace(
                /^(?:sees|saw|seeing|notices|noticed|noticing|watches|watched|hears|heard|realizes|realized|realises|realised|observes|observed|finds|found|discovers|discovered|remembers|remembered)_/,
                ""
            );
            if ((slug === "") || byslug.has(slug)) slug = key;
            // Witnesses: the acting character plus any other configured name
            // present in the same recent window.
            const low = recentText(cfg.distance);
            const witnesses = [agentName];
            for (const n of cfg.agents) {
                if ((n !== agentName) && mentions(low, n)) witnesses.push(n);
            }
            const card = addStoryCard(
                cueWords(value, witnesses),
                value,
                "Event",
                `${EVENT_PREFIX} ${slug}`,
                "",
                { returnCard: true }
            );
            writeEvent({
                card, slug, stub: value, body: value,
                salience: 60, turn: MP.turn, recalls: 0, witnesses,
            });
            MP.lastRecord = MP.turn;
            // The recorder holds the event but not yet a view of it. Copying the
            // third-person record in as their "view" would just duplicate the
            // card and leave nothing for them to disagree with later.
            upsert(slug, NO_VIEW, true);
            logOp(mindCard, `${agentName} records ${slug}: ${value}`);
            writeMind(mindCard, entries);
            sweep(cfg);
            return;
        }

        // Plain standing thought.
        if (entries.some(e => !e.link && (e.value === value))) return; // no duplicates
        upsert(key, value, false);
        logOp(mindCard, `${agentName} thinks ${key}: ${value}`);
        writeMind(mindCard, entries);
        return;
    }

    /**
     * Drop event cards nobody links to any more. Without this the card list
     * grows without bound: simulation showed roughly 70% of events unreferenced
     * by turn 400 and over 90% by turn 1600.
     */
    function sweep(cfg) {
        const referenced = new Set();
        for (const card of storyCards) {
            if ((typeof card.keys === "string") && card.keys.includes("\"mind\"")) {
                for (const e of readMind(card)) if (e.link) referenced.add(e.key);
            }
        }
        for (let i = storyCards.length - 1; -1 < i; i--) {
            const ev = parseEvent(storyCards[i]);
            if (!ev) continue;
            // Give a new event a grace period before it can be swept.
            if (referenced.has(ev.slug) || ((MP.turn - ev.turn) < 5)) continue;
            if (typeof removeStoryCard === "function") removeStoryCard(i);
            else storyCards.splice(i, 1);
        }
    }
}
