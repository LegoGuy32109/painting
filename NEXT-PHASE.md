# Next phase: interactive palette

Build this after the first interactive canvas slice (opaque 16×16 painting,
brushes, erase, undo, reset, and the basic selection bridge) is verified.

## Boundaries

- Keep canvas pixels and stroke history private to `<paint-canvas>`.
- Keep palette interaction inside `<paint-palette>`.
- Let DataStar own the small, inspectable page state: `$paint` and `$palette`.
- Use no additional dependencies. Browser code remains standard ES modules.

## Palette state

`$palette` holds the availability of the 16 fixed base colors and 12 mutable
custom wells. A custom well retains its five integer accumulators:

```text
totalRed, totalGreen, totalBlue, totalMaximum, numberOfColors
```

`$paint.selection.source` and `$paint.selection.index` identify the selected
base, custom, or picked source. `$paint.selection.color` is its convenient,
current RGB value. If the selected source is a custom well, refresh that RGB
whenever its derived well color changes.

The initial selection is empty (`source`, `index`, and `color` are `null`). The
canvas must not create a paint stroke until the player deliberately selects a
color. In that state, the large selected-color well shows the empty-well color
`#FFECE5` and no selected border. Normal paint mode also hides the brush
perimeter until a color is selected; Erase remains usable without a selection.
Toggling Erase preserves any existing selection; choosing a color turns Erase
off.

The fixed base-color order and names live in JavaScript; their RGB values are
read from the global `--mc-*` CSS variables, which remain the color source of
truth.

For these two prototype phases, seed every base well as available. Keep the
visible Add dye control disabled; acquisition belongs to later account or
inventory work. Because all 16 are available, Picker is enabled in the palette
phase.

## Component boundary

`<paint-palette>` has an open shadow root and receives its small state through
a JSON `palette-state` attribute. It renders the existing `<mc-color>`
presentational wells and updates itself optimistically before DataStar returns
the updated attribute as confirmation.

The palette is left aligned: the large selected-color well sits on the left,
with the base wells to its right. The current prototype intentionally hides the
custom wells and the deferred Add dye, Picker, and Water controls. Restore the
12 custom wells beneath the base wells and the action row when this phase
begins.

It emits:

- `palette-color-selected` for ordinary selection, with source, index, and RGB.
- `palette-state-changed` after a mix or cleanup, with the full custom-well
  array and any refreshed selection.

The page handles those events with DataStar `data-on:*` expressions.

## Interactions

- Available base wells and non-empty custom wells select on click/tap and can
  be drag sources.
- The large selected-color well is another drag source, notably for a picked
  color.
- A drag starts only after moving 6 CSS pixels. An eligible custom drop target
  receives a simple `drop-target` border.
- Dropping a color onto a custom well adds that source well's current displayed
  RGB as one mixing input. Dropping a custom well onto itself does nothing.
- Water is a drag-only source, not a persistent mode. Releasing it over one
  custom well clears that well and returns Water to neutral.
- Picker remains a one-use canvas mode: it is available only after all 16 base
  dyes exist; it samples the clicked cell's stored RGB, updates selection, and
  returns to paint mode. Transparent glass will later pick opaque black.

## Deferred beyond this phase

- Account and cross-device palette/tool synchronization.
- Durable offline outbox behavior.
- Glass canvases.
- Visual drag ghosts, animations, and the moving live-gallery presentation.
