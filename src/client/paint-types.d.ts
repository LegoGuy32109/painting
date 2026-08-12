export type BrushSize = 1 | 2 | 3 | 4;
export type OpacityPercent = 25 | 50 | 75 | 100;

export interface Cell {
  x: number;
  y: number;
}

export interface BrushBounds {
  minX: number;
  minY: number;
  size: number;
}

export interface PixelChange {
  index: number;
  previous: number;
  color: number;
}

export interface Stroke {
  id: string;
  pointerId: number;
  seen: Set<number>;
  snapshot: Int32Array;
  lastAnchor: Cell | null;
  changed: boolean;
  pendingCells: Array<[index: number, color: number]>;
  progressScheduled: boolean;
  sequence: number;
  paintedCellCount: number;
  brushSize: BrushSize;
  color: number;
  opacity: OpacityPercent;
}

export interface CanvasDocument {
  type: 0 | 1 | 2 | 3;
  glass: boolean;
  pixels: Int32Array;
  id: string;
  version: number;
  title: string | null;
  author: string | null;
  generation: number;
}

export interface PaintProgressDetail {
  canvasId: string;
  strokeId: string;
  sequence: number;
  cells: Array<[index: number, color: number]>;
}

export interface StrokeCommittedDetail {
  canvasId: string;
  strokeId: string;
  sequence: number;
  cellCount: number;
}

export interface UndoAvailabilityDetail {
  canUndo: boolean;
}

export interface ColorPickedDetail {
  color: string;
}

export interface PaletteSelection {
  source: "base" | "custom" | "picked" | null;
  index: number | null;
  color: string | null;
}

export interface PaletteWell {
  totalRed: number;
  totalGreen: number;
  totalBlue: number;
  totalMaximum: number;
  numberOfColors: number;
}

export interface PaletteState {
  baseAvailable: boolean[];
  customWells: PaletteWell[];
}
