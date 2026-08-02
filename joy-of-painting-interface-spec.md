# Joy of Painting interface specification

## Purpose

This specification recreates the painting experience from xerca's Joy of
Painting mod without Minecraft dependencies. It defines the paint tools,
palette, canvas geometry, color math, and persistent pixel format.

All colors use 8-bit ARGB integers. Write an opaque RGB color as
`0xFFRRGGBB`. For example, red is `0xFFFF0000`. A transparent glass cell is
`0x00000000`.

## Canvas types

Provide four canvas types. The pixel dimensions are fixed.

| Type | Type code | Width | Height | Main cells |
| --- | ---: | ---: | ---: | ---: |
| Small | 0 | 16 | 16 | 256 |
| Large | 1 | 32 | 32 | 1,024 |
| Long | 2 | 32 | 16 | 512 |
| Tall | 3 | 16 | 32 | 512 |

Each type has an opaque and a glass variant.

- A new opaque canvas fills every main cell with the base white `#F9FFFE`.
- A new glass canvas fills every main cell with `0x00000000`.
- Render glass cells over a checkerboard. This makes transparent cells clear
  during editing.
- Render small canvas cells at 10 screen pixels each. Render every other
  canvas at 5 screen pixels each.

## Base palette

The base palette has 16 fixed wells. A well is unavailable until its matching
dye has been added to the palette. Adding a dye records availability only. The
dye does not act as a consumable paint quantity after it is added.

| Index | Color name | Hex RGB |
| ---: | --- | --- |
| 0 | Black | `#1D1D21` |
| 1 | Red | `#B02E26` |
| 2 | Green | `#5E7C16` |
| 3 | Brown | `#835432` |
| 4 | Blue | `#3C44AA` |
| 5 | Purple | `#8932B8` |
| 6 | Cyan | `#169C9C` |
| 7 | Light gray | `#9D9D97` |
| 8 | Gray | `#474F52` |
| 9 | Pink | `#F38BAA` |
| 10 | Lime | `#80C71F` |
| 11 | Yellow | `#FED83D` |
| 12 | Light blue | `#3AB3DA` |
| 13 | Magenta | `#C74EBD` |
| 14 | Orange | `#F9801D` |
| 15 | White | `#F9FFFE` |

The palette is full only when all 16 wells are available. When it is full,
enable an eyedropper. The eyedropper samples the exact ARGB color from an
existing canvas cell. It is not a free-form color picker.

## Custom mixing wells

Provide exactly 12 custom wells. Each well is empty or contains a derived RGB
color. A well stores five signed integer values, not only the displayed color.

```text
totalRed
totalGreen
totalBlue
totalMaximum
numberOfColors
```

To add a selected source color `(r, g, b)` to a custom well, do this:

```text
totalRed       += r
totalGreen     += g
totalBlue      += b
totalMaximum   += max(r, g, b)
numberOfColors += 1
```

Do not allow a user to add a custom well to itself. It adds no useful color and
the original interaction prevents it.

To calculate the well's displayed color, use integer division that rounds down.

```text
if numberOfColors == 0:
    result = #FFECE5       // the empty-well display color only
else:
    averageRed     = floor(totalRed / numberOfColors)
    averageGreen   = floor(totalGreen / numberOfColors)
    averageBlue    = floor(totalBlue / numberOfColors)
    averageMaximum = floor(totalMaximum / numberOfColors)

    highestAverage = max(averageRed, averageGreen, averageBlue)
    gain = 0 if highestAverage == 0 else floor(averageMaximum / highestAverage)

    result = (
        gain * averageRed,
        gain * averageGreen,
        gain * averageBlue
    )
```

The result is opaque when painted. Store it as `0xFFRRGGBB`.

This is not subtractive pigment mixing. It is a repeated average with an
integer brightness gain. The same source color added twice has twice the weight.

### Water behavior

Provide a water control on the palette.

- Pick up water, then release it over a custom well.
- Reset all five values in that well to zero.
- Do not change any base-color availability flag.
- Do not use water as a canvas paint or a blending input.

## Painting controls

The user selects a base well, a non-empty custom well, or the eyedropper.
The selected color becomes the current paint color.

### Brush size

Provide four brush sizes. Size selection cycles in either direction and wraps.
The original UI uses the mouse wheel outside the opacity control.

Each brush applies its offset list once per cell during one mouse drag. Keep a
set of painted cell coordinates for the active drag. This prevents repeated
mouse events from blending the same cell more than once in the same stroke.

| Size | Cells per stamp | Offset list from the anchor |
| ---: | ---: | --- |
| 1 | 1 | `(0, 0)` |
| 2 | 4 | `(0,0), (-1,0), (0,-1), (-1,-1)` |
| 3 | 12 | `(-1,1), (0,1), (-2,0), (-1,0), (0,0), (1,0), (-2,-1), (-1,-1), (0,-1), (1,-1), (-1,-2), (0,-2)` |
| 4 | 21 | `(-1,2), (0,2), (1,2), (-2,1), (-1,1), (0,1), (1,1), (2,1), (-2,0), (-1,0), (0,0), (1,0), (2,0), (-2,-1), (-1,-1), (0,-1), (1,-1), (2,-1), (-1,-2), (0,-2), (1,-2)` |

For size 1 and size 4, anchor the brush at the cell under the cursor. For size
2 and size 3, anchor it at the nearest grid corner. Do not paint offsets outside
the canvas.

### Opacity

Provide four brush opacity settings. The original UI uses the mouse wheel over
the opacity control. It wraps after the last setting.

| Setting | Opacity `p` |
| ---: | ---: |
| 1 | 1.00 |
| 2 | 0.75 |
| 3 | 0.50 |
| 4 | 0.25 |

## Cell blending

Use this calculation for every affected cell. It is deliberately not normal
alpha compositing.

Let `A = (Ar, Ag, Ab)` be the selected paint color, `B = (Br, Bg, Bb)` be the
existing cell color, and `p` be the selected opacity.

```text
Ur = floor(p * Ar) + floor((1 - p) * Br)
Ug = floor(p * Ag) + floor((1 - p) * Bg)
Ub = floor(p * Ab) + floor((1 - p) * Bb)

targetPeak = floor(p * max(Ar, Ag, Ab))
           + floor((1 - p) * max(Br, Bg, Bb))

unscaledPeak = max(Ur, Ug, Ub)
gain = 0 if unscaledPeak == 0 else floor(targetPeak / unscaledPeak)

result = (gain * Ur, gain * Ug, gain * Ub)
```

Store `result` as `0xFFRRGGBB`. The integer floors and integer gain are part of
the behavior. Do not replace them with floating-point alpha compositing.

Example: 50% red `#FF0000` over blue `#0000FF` gives `#FE00FE`, not the usual
`#800080`.

### Erase action

Use the secondary mouse button as erase.

- On an opaque canvas, paint pure white `#FFFFFF` at 100% opacity.
- On a glass canvas, set the cell to `0x00000000`.
- On a glass canvas, painting into a transparent cell makes it opaque, even at a
  lower opacity setting.
- If a glass cell is already opaque, use the normal blend calculation.

This means an opaque canvas has no transparent clear state. Its erase result is
white. A glass canvas has a true clear state.

## Editing workflow

- Allow the canvas and palette panels to move independently.
- Keep their last positions separately for each canvas type.
- Do not blur the game scene behind the editor.
- Save up to 16 full-canvas undo snapshots.
- On each mouse press over paintable cells, make one snapshot. Discard it if the
  press makes no paint change.
- `Ctrl+Z` restores the most recent snapshot.
- Let a user sign a canvas with a title of up to 16 characters. Signing records
  the title and author, and makes the canvas immutable in normal use.

## Persistent canvas data

Represent a canvas as this game-agnostic record:

```text
Canvas {
  type: 0 | 1 | 2 | 3
  glass: boolean
  pixels: Int32[]              // row-major, width * height elements
  id: string
  version: non-negative integer
  title: string | null
  author: string | null
  generation: non-negative integer
}
```

Main pixels are row-major. The index for `(x, y)` is:

```text
index = y * width + x
```

Use a unique canvas ID in this form if byte-level compatibility with the source
behavior matters:

```text
<player UUID>_<current Unix milliseconds divided by 100>
```

Increment `version` whenever the client commits an edit. Use `generation` to
track copies: 0 for an unsigned or empty work, 1 for the original signed work,
2 for a copy of the original, and 3 or greater for later-generation copies.

For a save format compatible with the exported `.paint` structure, write a
binary NBT compound with these fields:

```text
pixels:     int[]       // required
ct:         byte        // canvas type code, required
glass:      boolean     // omit when false
title:      string      // include only for signed work
author:     string      // include only for signed work
name:       string      // canvas ID, include only for signed work
v:          int         // version, include only for signed work
generation: int         // include only for signed work
```

Do not encode pixels as a string of hex values. Preserve them as signed 32-bit
integers. A 16×16 canvas therefore contains 256 integers, and a 32×32 canvas
contains 1,024 integers.

## Synchronization behavior

This is optional in a single-player implementation. For multiplayer, send the
complete pixel array, ID, version, and canvas metadata when the editor closes.
While a player paints on a shared easel, send a full temporary update no more
often than once every 10 ticks. Accept an update only when the sender owns the
active easel session and remains within 8 blocks of the easel.
