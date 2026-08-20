# Archived phase: interactive palette and drag feedback

This prototype phase is complete. The application now also includes durable
guest drafts, offline synchronization, public live/replay presentation, signed
collections, and owner-scoped deletion. Keep this document as the original
interaction contract rather than a description of unfinished work.

Build this after the first interactive canvas slice (opaque 16×16 painting,
brushes, erase, undo, reset, and the basic selection bridge) is verified.

## Goal

Make the palette a complete, direct-manipulation color-mixing interface for
vertical phones first. A player can select colors, drag a color or water to a
custom well, and get clear motion and target feedback throughout the gesture.

The phase finishes when mouse, touch, and pen users can operate the interaction.
The phase does not add persistence, accounts, or new client dependencies.

## Requirements

### State and selection

- `$palette` holds the availability of the 16 fixed base colors and 12 mutable
  custom wells.
- Each custom well retains these five integer accumulators:

  ```text
  totalRed, totalGreen, totalBlue, totalMaximum, numberOfColors
  ```

- `$paint.selection.source` and `$paint.selection.index` identify the selected
  base, custom, or picked source. `$paint.selection.color` is its current RGB
  value.
- Refresh the selected RGB whenever its selected custom well's derived color
  changes.
- Start with no selection (`source`, `index`, and `color` are `null`). In that
  state, do not create paint strokes. Show the large well as `#FFECE5` with no
  selected border. Erase remains usable without a selection.
- Choosing a color disables Erase. Toggling Erase preserves an existing
  selection.
- Base-color order and names remain in JavaScript. Read their RGB values from
  the global `--mc-*` CSS variables.

### Phone-first palette layout and ordinary selection

- Treat narrow, vertical phone layouts as the primary layout. Horizontal-phone
  and monitor arrangements may remain functional without receiving dedicated
  layout refinement in this phase.
- Remove the New canvas button from this screen. Make the third control row an
  eight-track grid: Undo and Erase each span two tracks, and the selected-color
  well, Picker, Water, and disabled Add dye each use one track.
- Restore all 12 custom wells below the base-color wells.
- At the smallest supported phone width, use six wells per row. The 12 custom
  wells then occupy exactly two rows. Use eight base wells per row when the
  available width permits, otherwise use six.
- Do not add a separate custom-well drawer or horizontal scrolling. Every custom
  well is visible in the vertical phone palette.
- All 16 base wells are initially available in this prototype. Picker is
  therefore enabled. Add dye stays visibly disabled.
- An available base well or non-empty custom well selects on click/tap. The
  selected-color well reflects that selection and is also a drag source.
- Keep palette interaction inside `<paint-palette>` and emit the existing
  selection event plus `palette-state-changed` after a mix or cleanup. The page
  remains responsible for updating DataStar signals.

### Drag and drop behavior

- Start a drag only after the pointer moves 6 CSS pixels from a color-source
  press. A click/tap below that threshold remains a selection action.
- Valid color sources are available base wells, non-empty custom wells, and the
  large selected-color well. Water is a drag-only source.
- A valid custom-well target accepts one source color as one mixing input.
  Follow the integer mixing rules in the
  [interface specification](joy-of-painting-interface-spec.md).
- Dropping a custom well on itself is a no-op.
- Dropping Water on a custom well resets all five of its accumulators to zero.
- Releasing outside a valid target changes neither palette state nor selection.
- Use Pointer Events and pointer capture. Prevent native browser drag behavior.

### Drag and drop animation requirements

- On drag start, leave the source well in place and create a lightweight drag
  ghost above the interface. The ghost shows the source color, follows the
  pointer, and cannot intercept pointer events.
- Animate the ghost into view and out on release or cancellation. Respect
  `prefers-reduced-motion` by removing nonessential movement while keeping
  target feedback visible.
- Mark valid custom targets while a compatible source is dragged. The current
  target gets the `drop-target` treatment. Invalid targets receive no success
  styling.
- Animate target entry and exit without changing layout. A successful color drop
  briefly confirms the resulting well color. Water briefly confirms the cleared
  state.
- A rejected, self, or off-target drop returns the ghost to its source before
  removal. Do not mutate state until a valid drop is released.
- Never animate the canvas or interfere with a paint stroke. Palette dragging
  must not select text, scroll the page unexpectedly, or trigger browser image
  dragging.

### Accessibility and input quality

- Give every well and action an accessible name and clear disabled state.
- Keep click/tap color selection fully functional without dragging.
- Support mouse, pen, and touch through the same Pointer Events path.
- Maintain visible focus indicators. Keyboard mixing is not part of this phase.
  record it as a future accessibility enhancement rather than presenting drag
  and drop as keyboard accessible.

### Engineering constraints

- Keep canvas pixels and stroke history private to `<paint-canvas>`.
- Keep browser code as direct ES modules with no additional dependencies or
  build step.
- Use `// @ts-check` and extend `src/shared/paint-types.d.ts` for new event and
  palette shapes.
- Keep each interaction's state local to `<paint-palette>` until it emits a
  completed state change. It may render optimistically before the DataStar
  attribute update confirms the state.

## Delivery order

1. Reflow the controls and palette for vertical phones. Move the selected well
   and Water into the controls, remove New canvas, and render all 12 custom
   wells in two rows.
2. Add custom-well rendering, derived-color helpers, and state-change events.
   Test the mixing and clearing rules.
3. Add ordinary selection and selected-well synchronization.
4. Add Pointer Events drag recognition, hit testing, and valid-drop state
   updates without animation.
5. Add the drag ghost, target transitions, success confirmation, cancellation,
   and reduced-motion behavior.
6. Verify mouse, touch, and pen behavior on vertical phones. Run
   `deno task check` and `deno task test`.

## Acceptance checklist

- A base color, custom color, or selected picked color can be mixed into any
  other custom well.
- The displayed custom-well color exactly matches the specified integer
  calculation after every mix.
- Water clears exactly one dropped-on custom well.
- Self-drops and outside drops cause no state change.
- A drag begins only after 6 CSS pixels and always ends with either a clear
  success confirmation or a return-to-source cancellation.
- No native drag image appears, and painting on the canvas still works normally.
- `deno task check`, `deno task test`, and README lint all pass.

## Deferred beyond this phase

- Account and cross-device palette/tool synchronization.
- Durable offline outbox behavior.
- Glass canvases.
- Keyboard-operable custom-well mixing.
- Moving live-gallery presentation.
