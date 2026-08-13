/** Shared white gutter between adjacent QR module matrices. The grid-aware
 * receiver isolates symbols after acquisition, so one module preserves data
 * density without asking the generic detector to enumerate the whole grid. */
export const GRID_MARGIN_MODULES = 1;

export interface GridLayout {
  id: number;
  cols: number;
  rows: number;
}

export const GRID_LAYOUTS: readonly GridLayout[] = [
  { id: 0, cols: 1, rows: 1 },
  { id: 1, cols: 1, rows: 2 },
  { id: 2, cols: 2, rows: 2 },
  { id: 3, cols: 2, rows: 3 },
  { id: 4, cols: 3, rows: 4 },
  { id: 5, cols: 3, rows: 5 },
  { id: 6, cols: 5, rows: 3 },
];

export function gridLayoutById(id: number): GridLayout | undefined {
  return GRID_LAYOUTS.find((layout) => layout.id === id);
}

export function gridLayoutId(cols: number, rows: number): number {
  return GRID_LAYOUTS.find((layout) => layout.cols === cols && layout.rows === rows)?.id ?? 0;
}
