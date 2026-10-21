---
name: BaudTide
description: A calm, Linux-first serial workbench built around the live signal.
colors:
  dark-app: "oklch(15.5% 0.018 238)"
  dark-app-raised: "oklch(18% 0.02 236)"
  dark-surface: "oklch(20.5% 0.022 234)"
  dark-surface-raised: "oklch(24% 0.024 232)"
  dark-rail: "oklch(16.8% 0.019 239)"
  dark-border: "oklch(34% 0.028 226)"
  dark-border-subtle: "oklch(27% 0.024 230)"
  dark-ink: "oklch(94% 0.012 220)"
  dark-ink-soft: "oklch(82% 0.02 222)"
  dark-ink-muted: "oklch(68% 0.026 224)"
  dark-ink-dim: "oklch(55% 0.026 226)"
  dark-signal-aqua: "oklch(78% 0.13 172)"
  dark-signal-aqua-strong: "oklch(68% 0.14 172)"
  dark-signal-aqua-soft: "oklch(25% 0.058 172)"
  dark-signal-aqua-ink: "oklch(17% 0.035 172)"
  dark-focus: "oklch(84% 0.13 172)"
  dark-info: "oklch(74% 0.1 235)"
  dark-warning: "oklch(78% 0.13 78)"
  dark-danger: "oklch(68% 0.16 24)"
  light-app: "oklch(96.5% 0.008 224)"
  light-app-raised: "oklch(98% 0.006 224)"
  light-surface: "oklch(99.3% 0.004 224)"
  light-surface-raised: "oklch(94.5% 0.012 224)"
  light-rail: "oklch(93.5% 0.012 226)"
  light-border: "oklch(78% 0.026 224)"
  light-border-subtle: "oklch(87% 0.018 224)"
  light-ink: "oklch(22% 0.032 228)"
  light-ink-soft: "oklch(34% 0.032 226)"
  light-ink-muted: "oklch(46% 0.034 226)"
  light-ink-dim: "oklch(48% 0.032 224)"
  light-signal-aqua: "oklch(48% 0.13 172)"
  light-signal-aqua-strong: "oklch(41% 0.12 172)"
  light-signal-aqua-soft: "oklch(91.5% 0.045 172)"
  light-signal-aqua-ink: "oklch(22% 0.05 172)"
  light-focus: "oklch(43% 0.14 172)"
  light-info: "oklch(48% 0.11 235)"
  light-warning: "oklch(52% 0.12 78)"
  light-danger: "oklch(50% 0.15 24)"
typography:
  display:
    fontFamily: "Ubuntu Sans, Noto Sans, system-ui, sans-serif"
    fontSize: "clamp(2rem, 2.8vw, 2.75rem)"
    fontWeight: 680
    lineHeight: 1.06
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Ubuntu Sans, Noto Sans, system-ui, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 650
    lineHeight: 1.16
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Ubuntu Sans, Noto Sans, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 640
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Ubuntu Sans, Noto Sans, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  data:
    fontFamily: "Ubuntu Mono, Noto Sans Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
rounded:
  control: "0.375rem"
  panel: "0.5rem"
  pill: "999px"
spacing:
  2xs: "0.25rem"
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
  2xl: "3rem"
  3xl: "4.5rem"
components:
  button-primary-dark:
    backgroundColor: "{colors.dark-signal-aqua}"
    textColor: "{colors.dark-signal-aqua-ink}"
    rounded: "{rounded.control}"
    height: "40px"
  button-secondary-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-ink-soft}"
    rounded: "{rounded.control}"
    height: "36px"
  input-dark:
    backgroundColor: "{colors.dark-app-raised}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.control}"
    height: "40px"
  panel-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-ink-soft}"
    rounded: "{rounded.panel}"
  active-nav-dark:
    backgroundColor: "{colors.dark-surface-raised}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.control}"
    height: "42px"
---

# Design System: BaudTide

## Overview

**Creative North Star: "The Signal Workbench"**

BaudTide is an Operate interface designed as a calibrated technical instrument. Its graphite bench, ruled modules, compact tool strips, aligned data, and restrained signal-aqua state cues keep attention on device state and serial output. It is deliberately not a generic SaaS dashboard or a pile of promotional cards.

The visual story is one continuous signal path: orient to the device, inspect the signal, and act without leaving context. Persistent navigation and the sticky instrument bar establish the frame; one dominant working surface carries each task. The final implementation is locked and cleared to ship across direction, craft, coherence, and completeness.

**Key Characteristics:**

- Technical-instrument density with calm, direct hierarchy.
- Ruled and tonally layered surfaces instead of floating card piles.
- Signal aqua used sparingly for live, selected, focused, and ready states.
- Ubuntu Sans for interface language and Ubuntu Mono for machine data.
- Dark and light themes with equivalent semantic relationships.
- Functional charts, telemetry traces, and device previews as the only visual enrichment.

## Colors

The palette is a cool neutral bench in both themes. Dark mode uses graphite-blue depth; light mode uses low-chroma paper and steel neutrals. The frontmatter is the normative source for all color values.

### Primary

- **Signal Aqua:** Marks live connections, selected fields, active navigation indicators, focus, ready state, and primary actions. It is an operational signal, not decoration.
- **Signal Aqua Soft:** Provides selected-state and icon-tile backing without competing with terminal or chart content.

### Secondary

- **Instrument Blue:** Reserved for secondary traces and informational state where aqua would incorrectly imply active or selected.
- **Bench Amber:** Communicates warnings and exceptions.
- **Fault Red:** Communicates destructive actions, validation errors, and failure states; destructive controls retain physical separation from primary actions.

### Neutral

- **Bench / Raised Bench:** Forms the application canvas and deeper terminal or telemetry regions.
- **Instrument Surface / Raised Surface:** Separates controls, panels, hover states, and selected rows by tone.
- **Rail:** Gives persistent navigation its own quiet plane without turning it into a detached card.
- **Ink / Soft Ink / Muted Ink / Dim Ink:** Creates a four-step information hierarchy from primary content through metadata and placeholders.
- **Rule / Subtle Rule:** Defines control boundaries, row divisions, and region changes.

**The Signal Rarity Rule.** Signal aqua is reserved for action and state. Never wash large decorative regions in the accent.

**The Semantic Continuity Rule.** Light mode preserves the same role hierarchy and lowers chroma; it is not a mechanical inversion of dark mode.

## Typography

**Display Font:** Ubuntu Sans (with Noto Sans and system UI fallbacks)  
**Body Font:** Ubuntu Sans (with Noto Sans and system UI fallbacks)  
**Data Font:** Ubuntu Mono (with Noto Sans Mono and system monospace fallbacks)

**Character:** Ubuntu Sans keeps the interface contemporary, compact, and legible without losing the utilitarian feel of a Linux bench tool. Ubuntu Mono clearly distinguishes machine output and measurable state from interface prose.

### Hierarchy

- **Display:** Balanced screen and empty-state headings with compact leading; the welcome opening may expand to a larger responsive display treatment.
- **Headline:** Section, dialog, and major panel titles.
- **Title:** Subsection headings and fieldset legends.
- **Body:** Interface descriptions and operational guidance; longer explanatory copy stays near 60–62 characters per line.
- **Label:** Compact interface labels remain in Ubuntu Sans. Contextual labels use the smallest body size with ordinary casing and no decorative tracking.
- **Data:** Ports, byte counts, timestamps, measurements, shortcuts, terminal output, and status metadata use Ubuntu Mono with tabular numerals where values align or change.

**The Machine/Data Rule.** Mono type is evidence of machine data, not a general-purpose stylistic texture.

**The Context-After-Heading Rule.** Screen, saved-log, feedback, welcome, and dialog context labels follow the heading and supporting subtitle in reading order. They must not return to decorative above-title eyebrow treatment.

## Layout

The desktop shell is a Workbench: a persistent 236px navigation rail (68px compact), a sticky 60px instrument bar, and a centered task canvas capped at 1520px. Content padding follows the named 4-point spacing scale and expands from 16px to 48px with viewport width. Primary pages use a heading region, a ruled transition into the working surface, and one dominant terminal, list, chart, settings, or sharing task.

Lists are continuous ruled containers, not independent cards per row. Telemetry uses a 240–300px field rail beside a flexible chart. Mobile sharing uses a context column beside a functional phone preview. At 1080px, chart and sharing layouts collapse to one column; at 760px, the app uses the mobile top bar and single-column content; at 480px, action groups stack and fill the available width.

Interactive targets honor the responsive density model: desktop controls remain compact, while top-bar controls become at least 44×44px at 760px and primary, secondary, danger, and field controls become at least 44px high at 480px. The application remains usable from a 320px viewport without horizontal page overflow.

**The One Working Surface Rule.** Every operational screen establishes one primary task surface; secondary context is separated with rules or tonal changes, not equal-weight card grids.

## Elevation & Depth

BaudTide is flat by default. Borders, row rules, and small tonal steps communicate most hierarchy. The shallow panel shadow is reserved for the welcome instrument, small floating instrument callouts, the functional phone device, and other deliberately lifted demonstrations. The deeper popover shadow is reserved for dialogs, menus, command surfaces, drawers, and other transient layers. Backdrops use a darkened bench mix with restrained blur to preserve context.

### Shadow Vocabulary

- **Panel lift:** A broad, shallow ambient shadow for a genuinely raised instrument or functional preview.
- **Popover lift:** A stronger ambient shadow for transient surfaces that must sit unambiguously over active work.

**The Flat-by-Default Rule.** Ordinary cards, lists, terminals, charts, and settings panels use a border or tonal separation and no shadow.

## Shapes

The form language is gently machined: controls use a 6px radius and panels use an 8px radius. Borders are thin and functional. Pills are limited to status, transport metadata, short segmented states, and progress tracks. Row-based collections share one rounded outer container while internal rows stay square and are divided by rules.

The phone frame is a purposeful exception. It may retain device-specific silhouette, clipping, and lift because it previews a real mobile companion surface; that exception must not spread into ordinary application panels.

**The Functional Silhouette Rule.** Special framing is allowed only when it explains a real product surface or instrument state.

## Components

### Buttons

- **Shape:** Compact rectangular controls with gently machined corners (6px).
- **Primary:** Signal-aqua fill and border, dark accent ink, strong action-led label, and no resting shadow. Desktop height is 40px; narrow-screen actions expand to 44px.
- **Hover / Active:** Hover brightens toward the focus color and may rise by 1px; active returns immediately to rest.
- **Secondary:** Ruled instrument surface with soft ink; hover strengthens both the surface and border.
- **Destructive:** Fault-red text and border on a lightly tinted surface, separated from the primary action.
- **Disabled:** Reduced opacity with a not-allowed cursor; state remains visible rather than disappearing.

### Chips

- **Style:** Pills are compact, mono-set state readouts with a subtle rule and raised-bench fill.
- **State:** Selected filter segments use signal-aqua soft with signal-aqua text; connected and live indicators use the solid accent.

### Cards / Containers

- **Corner Style:** 8px outer radius with a 1px subtle rule.
- **Background:** Instrument surface for supporting panels; raised bench or bench for terminal and telemetry depth.
- **Shadow Strategy:** None for ordinary work surfaces; use only the elevation exceptions defined above.
- **Internal Padding:** Usually 16–24px, with compact toolbars using 8–12px.
- **Lists:** One shared outer container, square internal rows, and a dividing rule between rows.

### Inputs / Fields

- **Style:** Raised-bench fill, 1px rule, 6px radius, and soft-to-primary ink hierarchy. Desktop height is 40px; narrow-screen fields are 44px high and use 1rem text to avoid mobile zoom.
- **Focus:** Focus border plus a 2px signal-aqua outline with a 1px offset.
- **Hover:** Border strengthens without changing geometry.
- **Error / Disabled:** Fault red identifies errors; disabled controls retain layout and use reduced opacity.

### Navigation

- **Style:** Persistent rail with 42px desktop rows, compact Ubuntu Sans labels, and quiet mono section/status text.
- **State:** Hover introduces a subtle surface and rule. Active state uses the raised surface, stronger border, primary ink, aqua icon, and a small aqua signal dot.
- **Mobile:** The rail becomes a drawer; top-bar controls meet the 44×44px target.

### Terminal and Telemetry

- **Terminal:** Uses the deepest bench surface, Ubuntu Mono, tabular numerals, dim timestamps, and ruled lines so output remains dominant.
- **Telemetry:** Keeps field selection in a ruled side rail and charts in a deeper plot surface; aqua identifies the primary live series and blue is secondary.
- **Motion:** Page surfaces use one short 240ms settle. Routine hover and press feedback uses the 160ms timing. Reduced-motion replaces spatial movement with near-immediate opacity/state feedback.

### Event timeline and inspection

- **Timeline:** Extends the existing Operate working surface below the charts with a ruled, per-capture event list, newest first. Rows combine a breach or note icon, clear title, optional notes, mono timestamp, and Inspect action; hover uses the raised surface and selection uses aqua-soft backing. The list scrolls within a bounded region (260px), with older events revealed in groups of 50.
- **Manual markers:** Add marker opens an inline form with a title, optional notes, and capture time. Live markers use the save time; saved captures accept seconds from capture start. Inputs retain the established bench fill, rule, control radius, and focus treatment; Save marker and Cancel close the form, with local-save context beneath the actions on narrow screens.
- **Chart markers:** Breaches use amber dashed vertical lines; notes use aqua solid lines. The inspected event gets a stronger line (2px, full opacity) and a compact Breach or Note label, preserving the trace as the dominant content.
- **Inspection:** A ruled bench section shows the event title, source, timestamp, and notes above Before and After controls (10 seconds each by default). Apply window updates the chart window and bounded serial context. Mono output scrolls within its own region (300px), displays signed time offsets, and highlights and reveals the nearest line with aqua-soft backing; line counts and approximate-timing guidance remain visible.
- **Keyboard and themes:** Event rows are buttons with pressed state. Opening or completing inspection reveals and focuses its heading; the serial region is keyboard focusable. Controls, rows, and focusable regions use a visible focus outline (2px). Light mode uses the stronger existing muted-ink and accent tokens for metadata and Inspect text; dark and Sage retain their established semantic roles.
- **Narrow screens:** At a 390px viewport, marker fields stack, event timestamps move below titles, context headings stack, and long notes and output wrap. Form text grows to 16px and inputs and heading actions meet the 44px target at 480px and below; the breach toast's Inspect breach action also stays at least 44px high.

### Bench workflows

- **Log rules and command sequences:** Collapsible, ruled tools beneath the terminal composer. Summaries expose the armed or saved count; expanded tools group configuration, explicit execution actions, and feedback. Ubuntu Sans carries labels and guidance; Ubuntu Mono is reserved for command payloads, cooldowns, step numbers, readings, and timestamps. Controls inherit the semantic Dark, Light, and Sage tokens.
- **Sequence editor and results:** Named steps form one continuous list. Each step groups its command, text/hex mode, response check, timeout, and delay. Run results retain the numbered structure, with aqua for passed steps, fault red for failed or stopped steps, and a visible Stop action above the terminal and within the tool while running. Removing a draft step requires confirmation.
- **Run comparison:** Baseline and candidate occupy paired columns, marked with aqua and blue respectively. Each side owns its capture, signal, and alignment event. An interval bar leads into a compact statistics table and a shared original-unit chart. Signed time labels support inspection before an event. The paired controls stack below 700px; long selections truncate within their field and the statistics table scrolls within its own region.
- **Responsive controls:** New fields and actions meet the 44px target at 480px and below. Labels and selectors have explicit shrinking grid tracks so long capture names and event titles cannot widen the working surface. All keyboard controls retain a visible focus outline.

### Dialogs and Menus

- **Style:** Structured sheets with a clear title, supporting text, contextual label after the heading content, grouped controls, and fixed action closure.
- **Depth:** Stronger border, popover shadow, and restrained blurred backdrop make the transient layer explicit.
- **Focus:** Visible keyboard focus is immediate throughout the sheet and its close control.

## Do's and Don'ts

### Do:

- **Do** keep the live signal, terminal output, or current task more prominent than surrounding chrome.
- **Do** preserve both dark and light semantic themes and use the project-root `tokens.css` as implementation truth.
- **Do** preserve the BaudTide mark and the Workbench shell across screens.
- **Do** place contextual labels after the heading and supporting text in the established reading order.
- **Do** use Ubuntu Mono only for ports, bytes, timestamps, measurements, shortcuts, terminal content, and comparable machine data.
- **Do** maintain visible focus treatment, distinct hover/active/disabled/error states, keyboard access, and responsive 44px targets.
- **Do** keep routine motion short and state-led, and honor reduced-motion preferences.

### Don't:

- **Don't** turn operational screens into floating card dashboards, generic icon-card grids, or promotional compositions.
- **Don't** use signal aqua as broad decoration or confuse warning and destructive semantics with live state.
- **Don't** move contextual labels back above headings as decorative eyebrows.
- **Don't** add decorative illustrations, invented metrics, commercial claims, or unrelated visual themes.
- **Don't** combine a heavy shadow with ordinary bordered work surfaces.
- **Don't** apply pill geometry to ordinary buttons, panels, or long controls.
- **Don't** remove the functional phone frame from the mobile companion preview or reuse that device framing elsewhere.
