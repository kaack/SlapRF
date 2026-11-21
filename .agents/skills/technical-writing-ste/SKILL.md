---
name: technical-writing-ste
description: >-
  Write and edit SlapRF documentation, README.md, API descriptions, release notes, and UI help text
  using ASD-STE100 Simplified Technical English (STE) while eliminating AI-generated prose tells
  ("AI slop"). Activate whenever authoring or editing user-facing documentation, README copy, or
  explanatory UI text.
---

# Technical Writing: Simplified Technical English (STE) & Anti-AI-Slop Rules

Apply these rules whenever writing or editing `README.md`, `docs-site/content/**`, OpenAPI/AsyncAPI descriptions, release notes, or in-app help copy.

## 1. ASD-STE100 Simplified Technical English Principles

1. **Use Active Voice and Imperative Verbs**:
   - Procedural steps start with an action verb: `Connect the antenna to the U.FL socket.` (Not: `The antenna should be connected to the U.FL socket.`)
   - Descriptive statements name the actor: `The Hub sends the channel table to all Spokes.` (Not: `The channel table is broadcast across the network.`)
2. **Keep Sentences Short and Focused**:
   - **Procedural sentences**: Aim for **20 words or fewer**, with **one action per step** (or two tightly coupled actions such as `Select Settings and click Connect`).
   - **Descriptive sentences**: Aim for **25 words or fewer**, expressing one idea per sentence.
3. **One Term Per Concept (Consistent Terminology)**:
   - Do not rotate synonyms for stylistic variety. Pick the exact domain noun (`Hub`, `Spoke`, `timer`, `gate`, `pass`, `section split`, `threshold`) and use it consistently.
   - Distinguish **SlapRF App** (the timing software) from **SlapRF DIY Timers** (the Seeed XIAO ESP32-C5 hardware boards).
4. **State Concrete Facts, Numbers, and Units**:
   - Replace vague adjectives with measurable specs: write `~$25 per timer`, `5.8 GHz Raceband`, `50 Hz`, `115200 baud`, `< 1 ms`, `zero soldering` rather than "ultra-affordable", "blazingly fast", or "effortless hardware assembly".
5. **Put Conditions Before Actions**:
   - Write `If the status LED blinks red, hold BOOT and tap RESET.` (Not: `Hold BOOT and tap RESET if the status LED is blinking red`, so the reader knows whether the step applies before acting.)

---

## 2. Eliminating AI-Slop Dead Giveaways

Never emit any of the following patterns in documentation, `README.md`, or UI copy:

1. **Zero Em-Dashes**:
   - Never use the em-dash character in prose, tables, headings, or UI strings. Rewrite with a colon, period, comma, or parentheses.
2. **Banned AI Puffery & Filler Vocabulary**:
   - Never use: `seamless`, `seamlessly`, `effortless`, `effortlessly`, `robust`, `cutting-edge`, `next-generation`, `leverage` (use `use`), `utilize` (use `use`), `delve`, `dive into`, `unlock`, `supercharge`, `empower`, `streamline`, `elevate`, `game-changer`, `ecosystem`, `comprehensive`, `battle-tested`, `under the hood`, `first-class`.
3. **Banned Rhetorical Templates**:
   - **No "Not only X, but also Y"** or **"Whether you're a beginner or a seasoned pro..."** framing.
   - **No throat-clearing intros**: Delete opening fluff like *"In modern FPV drone racing, accurate timing is essential..."* or *"This guide walks you through everything you need to know about..."*. State what the feature does in sentence one.
   - **No restatement conclusions**: Do not end pages or sections with *"In summary, SlapRF provides a powerful way to..."*. Stop after the last technical step or fact.
   - **No artificial rule-of-three adjective chains** (for example *"fast, reliable, and intuitive"*).
4. **Clean Formatting Over Decoration**:
   - Do not put decorative emojis in Markdown headings, bullet lists, or comparison tables.
   - Prefer scannable 2-to-4 column Markdown tables for comparisons, LED states, CLI flags, and quick-start choices over walls of paragraphs.

---

## 3. Quick Before / After Calibration

- **Bad (AI slop)**:
  > Whether you're running casual weekend packs or a full club championship, SlapRF seamlessly leverages the ESP32-C5's dual-band radio to unlock effortless, rock-solid lap timing right out of the box.
- **Good (STE)**:
  > SlapRF times `5.8 GHz` FPV drone laps and `S1`/`S2`/`S3` section splits. Run it with `~$25` Seeed XIAO ESP32-C5 timers, RotorHazard timers, or ImmersionRC LapRF 8-Way timers.
