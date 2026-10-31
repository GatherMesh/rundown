# Design notes

## Files

| Path | What it is |
|---|---|
| `design/screens/*.png` | Rendered screenshots — **the visual source of truth** |
| `design/static/*.html` | The same screens as plain static HTML/CSS (open in a browser, inspect spacing) |
| `design/source/*.dc.html` | Original design-tool source (template syntax `{{ }}`, `<sc-for>`); data arrays in the `<script>` at the bottom double as sample data |

Screens: `Main` (Sessions), `Templates`, `Export`, `PackProducer` (A4 landscape output),
`PackSpeaker` (A4 portrait output). People and Categories pages are not designed — reuse the
patterns (white cards on grey ground, same inputs, tables and pills).

## Tokens

| Token | Value | Use |
|---|---|---|
| `ground` | `#F5F6F8` | app background |
| `surface` | `#FFFFFF` | cards, panels, top bar |
| `surface-muted` | `#F8F9FB` | table header, locked inputs |
| `border` | `#E2E5EA` | card / panel borders |
| `border-input` | `#D5D9E0` | input borders |
| `divider` | `#EEF0F3` | table row rules |
| `ink` | `#16181D` | primary text |
| `ink-2` | `#3D4350` | secondary text |
| `ink-3` | `#5B6270` | labels, meta (passes 4.5:1 on white) |
| `primary` | `#2457D6` | primary buttons, active tab underline, links, selection |
| `primary-tint` | `#EEF3FF` / `#F5F8FF` | selected row / selected tile |
| `danger` | `#B42318` | destructive text |

Category pills (`bg` / `fg`): Walk-in `#EEF0F3/#4A5160` · Host `#E6EEFF/#1F49B6` ·
Music `#F1E9FF/#6B34C9` · Prayer `#E5F5EC/#1C7A47` · Video `#E3F4F6/#126B78` ·
Offering `#FBF3D9/#7A5B00` · Spoken `#FFF0E3/#A4510E`.

Type: **Inter** (400/500/600/700) for UI; **JetBrains Mono** (400/500) for every time and duration.
Sizes: page title 20/700, section title 15/600, body 14, table 13–14, labels 12/500,
overline labels 11/600 uppercase +0.06em.

Shape: radius 12 cards, 8 inputs/buttons, 6 small buttons, 999 pills. Inputs 40 px tall,
buttons 36–44 px. Top bar 56 px. Sidebar 240–280 px, detail panel 380–440 px.

Selection: row tint `#EEF3FF` + 3 px inset left bar in `primary`.

Print pages: black ink on white, 2 px header rule, 1 px row rules `#C9CED6`, body text ≥ 12 px,
overline labels 10 px uppercase. No colour required to read them (grayscale-safe).

## Quasar mapping

Set in `quasar.variables.scss`: `$primary: #2457D6`, `$negative: #B42318`, `$dark` unused
(light mode only). Use `q-input outlined dense`, `q-select outlined dense`, `q-btn unelevated no-caps`,
`q-btn-toggle` for segmented controls, `q-toggle` for switches, `q-chip` for people and
category pills (custom colours), `q-tabs` for top nav. Override Quasar's default font with Inter.
