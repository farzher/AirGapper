const GRID_MARGIN_MODULES = 1;
const GRID_LAYOUTS = [
  { id: 0, cols: 1, rows: 1 },
  { id: 1, cols: 1, rows: 2 },
  { id: 2, cols: 2, rows: 2 },
  { id: 3, cols: 2, rows: 3 },
  { id: 4, cols: 3, rows: 4 },
  { id: 5, cols: 3, rows: 5 },
  { id: 6, cols: 5, rows: 3 },
  { id: 7, cols: 3, rows: 6 },
  { id: 8, cols: 4, rows: 6 },
  { id: 9, cols: 4, rows: 8 }
];
function gridLayoutById(id) {
  return GRID_LAYOUTS.find((layout) => layout.id === id);
}
function gridLayoutId(cols, rows) {
  var _a, _b;
  return (_b = (_a = GRID_LAYOUTS.find((layout) => layout.cols === cols && layout.rows === rows)) == null ? void 0 : _a.id) != null ? _b : 0;
}
export {
  GRID_LAYOUTS,
  GRID_MARGIN_MODULES,
  gridLayoutById,
  gridLayoutId
};
