<!-- Add a banner image here once we have one:
<p align="center">
  <img src="https://raw.githubusercontent.com/zommelier/memorypalace/main/assets/banner.png" width="800">
</p>
-->

# Memory Palace 🕮
### *Everyone remembers it differently~*

---

## Overview

Memory Palace is an AI Dungeon mod that gives the characters in your story a memory of shared events, where each one keeps their own view of what happened.

When something worth remembering happens, it becomes a single event card. Any character who was there can link to that card and attach what it meant to *them*. The record stays one record; the interpretations are private and can contradict each other. Later, when the moment becomes relevant again, characters can bring it up on their own — the player never has to name it first.

Built on the architecture of [Inner Self](https://github.com/LewdLeah/Inner-Self) by LewdLeah, which is where the whole approach comes from. Memory Palace replaces Inner Self rather than extending it, so run one or the other, not both.

---

## Main Features

| Feature | Description |
|:--------|:------------|
| **Shared Event Records** | One card per salient moment, linked by everyone who witnessed it |
| **Private Interpretations** | Each character's view of an event is their own, and may contradict the record |
| **Unprompted Recall** | Cue words bring past events back into play without the player mentioning them |
| **Correlated Forgetting** | Memories fade for every witness at once, so a shared past stays shared |
| **Standing Thoughts** | Characters also keep beliefs that aren't tied to any single event |
| **Zero Immersion Breaks** | No "press continue" turns; memory and prose come from the same generation |
| **Hand-Editable Cards** | Read or rewrite any character's memory directly in the story card notes |
| **Name-Based Triggers** | Characters activate when the story mentions them, and coexist cleanly |

---

## Permission

Memory Palace is free and open-source under the MIT license, inherited from Inner Self, and the original copyright notice stays with it. Use it, copy it, modify it, publish scenarios with it. Please enjoy.

---

## Scenario Script Install Guide

1. Open the [AI Dungeon website](https://aidungeon.com/) on a PC (or request the desktop site on mobile)
2. Start a new scenario, or edit one you already have
3. Open the `DETAILS` tab at the top of the editor
4. Scroll to `Scripting` and switch on → `Scripts Enabled`
5. Click `EDIT SCRIPTS`
6. Choose the `Input` tab on the left
7. Clear everything already in that tab
8. Paste this in its place:
```javascript
// Your "Input" tab should look like this
MemoryPalace("input");
const modifier = (text) => {
  // Any other input modifier scripts can go here
  return { text };
};
modifier(text);
```
9. Choose the `Context` tab on the left
10. Clear everything already in that tab
11. Paste this in its place:
```javascript
// Your "Context" tab should look like this
MemoryPalace("context");
const modifier = (text) => {
  // Any other context modifier scripts can go here
  return { text, stop };
};
modifier(text);
```
12. Choose the `Output` tab on the left
13. Clear everything already in that tab
14. Paste this in its place:
```javascript
// Your "Output" tab should look like this
MemoryPalace("output");
const modifier = (text) => {
  // Any other output modifier scripts can go here
  return { text };
};
modifier(text);
```
15. Choose the `Library` tab on the left
16. Clear everything already in that tab
17. Open the Library code (link below) in a second browser tab
- [Library code](./library.js)
18. Copy *all* of it and paste it into your empty `Library` tab
19. Press the yellow `SAVE` button in the top right

### *That's everything!*

Every adventure played from your scenario now includes Memory Palace, including adventures already in progress.

<sub>Have a look at the in-game config card when you start!</sub>

---

## Gameplay Tips

- Open the config card in-game to see how to add characters
- Two or more characters who share scenes is where this mod earns its keep — see below
- Do not add the player character; the player keeps their own memories
- Set response length to 200 tokens if outputs come back short or empty
- If no config card appears, scripts are probably off (homepage > settings > gameplay)
- What you write in plot essentials matters, because the model sees it while deciding what is worth remembering
- Characters record roughly one thing at a time, so give a memory a few turns to form
- Story models differ a lot in how well they follow the operation format

---

## For Creators

### Creator Control Panel

The top of the `Library` tab holds every default setting with a short note on what it does. Change these before publishing to set the experience your players start with.

### Preparing Scenario Characters

Memory Palace needs to know which characters remember things. It builds a memory card for each one on demand, the first time their name shows up in the story, so a new adventure doesn't open with a wall of cards.

There are two ways to hand over the names:

<details>
<summary><b>regular method (click to expand)</b></summary>

Near the top of your `Library` tab:
```javascript
// List the first name of every NPC who should remember things:
IMPORTANT_SCENARIO_CHARACTERS: ""
// (comma separated inside the "" like so: "Leah, Bram, Cass")
```
Put your names between the quotes, then hit `SAVE`.

</details>

<details>
<summary><b>alternative method for mobile creators (click to expand)</b></summary>

Put an `@` in front of a normal story card title and Memory Palace will treat it as a character who remembers:
- Example card name: `@Leah`
- Use plain first names
- Much easier to do from a phone

</details>

### One Character vs Several

<details>
<summary><b>(click to expand)</b></summary>

With a single character configured, the mod still runs, but it is doing a smaller job. Every event ends up with one witness, so nothing is ever shared and nobody ever disagrees. What you get is episodic memory for that one character: events they can raise without prompting, plus their standing thoughts. That is worth having on its own.

The rest of the design only wakes up with two or more characters who appear in scenes together. That is when one event card starts collecting several views, and when a moment two people remember differently becomes something the story can actually use.

</details>

### Seeding Memories and Views

<details>
<summary><b>(click to expand)</b></summary>

Both card types are plain text and safe to write by hand.

A **memory card** holds one line per entry. A value beginning with `→` is a link to an event card, and the key is then that event's name. A lone `?` means the character was present but has not put their view into words yet; the mod will ask them for one.

```
who_i_am: I keep this house because my mother kept it.
stalled_site: → I said nothing, but I had flagged the survey twice.
the_inspection: → ?
```

An **event card** puts real cue words in the keys, so AID's own story card system brings the one-line record back whenever those words appear. The notes hold the bookkeeping and the full text:

```
title    ⌛ stalled_site
keys     trench, groundwater, pumps, survey
entry    The trench filled with groundwater and the pumps ran all morning.
notes    memorypalace: event
         salience: 60
         turn: 24
         recalls: 3
         witnesses: Leah, Bram
         ---
         The trench filled with groundwater and the pumps ran all morning.
```

To ship a scenario with history already in place, write the event cards yourself and give each character a link with their own view. Everything after that is handled in play.

Do not use a character's own name as a cue word. It is the most common word in any scene they appear in, so it will pull every one of their memories into context at once.

</details>

---

## Design Notes

<details>
<summary><b>(click to expand)</b></summary>

Three choices here differ from Inner Self, each settled by simulation rather than taste.

**Forgetting is handled by the script, not chosen by the model.** Salience belongs to the event, so every witness drops the same memory on the same turn. When each witness prunes on their own judgement, shared memories decay from about 8 to about 2 over 1600 turns; with salience on the event they hold steady around 15. The model still decides what survives, but through recall — bringing an event up raises it, silence lets it sink. A useful side effect is that no turn is ever spent on forgetting.

**The prompt carries a menu of events already on record.** A character can only link to a moment they can see. With no menu, witnesses never land on the same card and duplicates run about 1.5 cards per real event. With twelve names on the menu, ranked by who was there, witnesses agree about 79% of the time and duplication drops to 1.11x. Past about twelve names it stops helping and just costs context.

**New events are rate limited.** Nothing merges two cards after the fact, so every duplicate is a permanent split in the record. The cooldown is the main defence.

Event names are also normalised before storing: prompt vocabulary comes off (`thought_x` → `x`) and so does the observer (`norman_sees_stalled_site` → `stalled_site`), because a name written from one witness's eyes is awkward for the next witness to use. Recall then matches loosely, so a paraphrased name still finds its card.

</details>

---

## Changelog

<details>
<summary><b>(click to expand)</b></summary>

### 0.1
- Memory Palace released
- Event cards, per-character links, cue-based recall, salience-driven forgetting

</details>

---

## Credits

<details>
<summary><b>(click to expand)</b></summary>

- [Inner Self](https://github.com/LewdLeah/Inner-Self) and [Auto-Cards](https://github.com/LewdLeah/Auto-Cards) by [LewdLeah](https://play.aidungeon.com/profile/LewdLeah), whose architecture this is built on. Hiding data in story card keys, the config card and its typo-tolerant lookup, the tolerant parsing of model output, and the weighted name triggers are all theirs.

</details>

<p align="center"><b>Memory Palace v0.1</b> · built on <a href="https://github.com/LewdLeah/Inner-Self">Inner Self</a> by <a href="https://play.aidungeon.com/profile/LewdLeah">LewdLeah</a></p>
