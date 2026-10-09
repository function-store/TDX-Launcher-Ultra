import { useState } from "react";
import type { ToolboxTool, ToolboxView } from "./types";
import { TOOLBOX_OPEN_KEY, TOOLBOX_EXPANDED_KEY } from "./uiPersist";

type Props = {
  view: ToolboxView;
  search: string;
  selectedPath: string | null;
  selectedRef: React.MutableRefObject<HTMLElement | null>;
  /** Tool ids with a fetch in flight. */
  busyIds: Set<string>;
  onSelect: (path: string) => void;
  onDragStart: (path: string, e: React.DragEvent) => void;
  onFetch: (tool: ToolboxTool) => void;
  onAddTool: (category: string) => void;
  onEditTool: (tool: ToolboxTool) => void;
  onMoveTool: (id: string, direction: "up" | "down") => void;
  onAddCategory: () => void;
  onEditCategory: (name: string) => void;
  /** Current drop target while dragging files ('' = top level, null = none). Owned by App. */
  dropCategory: string | null;
  /** Called while dragging files over the Toolbox ('' = top level, null = left it). */
  onDropTargetChange?: (category: string | null) => void;
  /** Load a .tox into a running session; absent = no eligible session. */
  onPlace?: (path: string) => void;
  placeTitle?: string;
  /** Right-click on a tool row. */
  onToolContextMenu?: (tool: ToolboxTool, e: React.MouseEvent) => void;
  /** Right-click on a category row. */
  onCategoryContextMenu?: (name: string, e: React.MouseEvent) => void;
  /** Right-click on the Toolbox header / chrome. */
  onHeaderContextMenu?: (e: React.MouseEvent) => void;
};

function readOpen(): boolean {
  try {
    return localStorage.getItem(TOOLBOX_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeOpen(open: boolean) {
  try {
    localStorage.setItem(TOOLBOX_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(TOOLBOX_EXPANDED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === "string"));
  } catch {
    /* ignore */
  }
  return new Set();
}

function writeCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(TOOLBOX_EXPANDED_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

function matchesTool(tool: ToolboxTool, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  const hay = `${tool.label} ${tool.source} ${tool.category} ${tool.notes}`.toLowerCase();
  return f.split(/\s+/).every((part) => hay.includes(part));
}

function kindIcon(tool: ToolboxTool): string {
  if (tool.kind === "package") return "▦";
  if (tool.kind === "url" && !tool.resolvedPath) return "☁";
  return "◆";
}

function kindHint(tool: ToolboxTool): string {
  switch (tool.kind) {
    case "local":
      return tool.missing ? `${tool.source} (missing)` : `${tool.source}\nDrag into a TouchDesigner network`;
    case "url":
      return tool.resolvedPath
        ? `${tool.source}\nCached: ${tool.resolvedPath}\nDrag into a TouchDesigner network`
        : `${tool.source}\nClick to fetch the .tox, then drag it into TouchDesigner`;
    default:
      return `${tool.source}\nPackage spec — install via Companion → Load ▾ → From package, or copy the spec`;
  }
}

function ToolRow({
  tool,
  depth,
  busy,
  selectedPath,
  selectedRef,
  dropActive,
  onSelect,
  onDragStart,
  onFetch,
  onEditTool,
  onMoveTool,
  onDropTarget,
  onPlace,
  placeTitle,
  onToolContextMenu,
}: {
  tool: ToolboxTool;
  depth: number;
  busy: boolean;
  selectedPath: string | null;
  selectedRef: React.MutableRefObject<HTMLElement | null>;
  dropActive: boolean;
  onSelect: (path: string) => void;
  onDragStart: (path: string, e: React.DragEvent) => void;
  onFetch: (tool: ToolboxTool) => void;
  onEditTool: (tool: ToolboxTool) => void;
  onMoveTool: (id: string, direction: "up" | "down") => void;
  onDropTarget: (category: string | null) => void;
  onPlace?: (path: string) => void;
  placeTitle?: string;
  onToolContextMenu?: (tool: ToolboxTool, e: React.MouseEvent) => void;
}) {
  const draggable = !!tool.resolvedPath && !tool.missing;
  const selected = !!tool.resolvedPath && tool.resolvedPath === selectedPath;
  return (
    <div
      role="treeitem"
      draggable={draggable}
      ref={(el) => {
        if (selected) selectedRef.current = el;
      }}
      className={[
        "palette-file-row",
        "toolbox-tool-row",
        selected ? "selected" : "",
        tool.missing ? "missing" : "",
        draggable ? "draggable-tox" : "",
        dropActive ? "drop-over" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-toolbox-drop={tool.category}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={kindHint(tool)}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        onDropTarget(tool.category);
      }}
      onDragLeave={(e) => {
        e.stopPropagation();
        onDropTarget(null);
      }}
      onClick={() => {
        if (tool.resolvedPath) onSelect(tool.resolvedPath);
        else if (tool.kind === "url" && !busy) onFetch(tool);
        else if (tool.kind === "package") onEditTool(tool);
      }}
      onContextMenu={
        onToolContextMenu ? (e) => onToolContextMenu(tool, e) : undefined
      }
      onDragStart={(e) => {
        if (draggable && tool.resolvedPath) onDragStart(tool.resolvedPath, e);
      }}
    >
      <span className="palette-twist spacer" aria-hidden />
      <span className="palette-file-icon" aria-hidden>
        {busy ? "…" : kindIcon(tool)}
      </span>
      <span className="palette-file-name">
        {tool.label}
        {tool.missing ? " (missing)" : ""}
        {tool.kind === "url" && !tool.resolvedPath && !busy ? (
          <span className="toolbox-fetch-hint"> — click to fetch</span>
        ) : null}
      </span>
      <span className="toolbox-row-actions" onClick={(e) => e.stopPropagation()}>
        {onPlace && tool.resolvedPath && !tool.missing && (
          <button
            type="button"
            className="toolbox-mini"
            title={placeTitle ?? "Place in a running session"}
            onClick={() => {
              if (tool.resolvedPath) onPlace(tool.resolvedPath);
            }}
          >
            ↳
          </button>
        )}
        {tool.kind === "url" && (
          <button
            type="button"
            className="toolbox-mini"
            title={tool.resolvedPath ? "Re-fetch (update to latest)" : "Fetch .tox"}
            disabled={busy}
            onClick={() => onFetch(tool)}
          >
            ⟳
          </button>
        )}
        <button
          type="button"
          className="toolbox-mini"
          title="Move up"
          onClick={() => onMoveTool(tool.id, "up")}
        >
          ▲
        </button>
        <button
          type="button"
          className="toolbox-mini"
          title="Move down"
          onClick={() => onMoveTool(tool.id, "down")}
        >
          ▼
        </button>
        <button
          type="button"
          className="toolbox-mini"
          title="Edit tool (label, category, source, remove)"
          onClick={() => onEditTool(tool)}
        >
          ✎
        </button>
      </span>
    </div>
  );
}

export default function ToolboxSection({
  view,
  search,
  selectedPath,
  selectedRef,
  busyIds,
  onSelect,
  onDragStart,
  onFetch,
  onAddTool,
  onEditTool,
  onMoveTool,
  onAddCategory,
  onEditCategory,
  dropCategory,
  onDropTargetChange,
  onPlace,
  placeTitle,
  onToolContextMenu,
  onCategoryContextMenu,
  onHeaderContextMenu,
}: Props) {
  const [open, setOpen] = useState(readOpen);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);

  // HTML5 fallback path only — native drags are hit-tested by App via the
  // data-toolbox-drop markers, which also drives the dropCategory prop.
  const setDropTarget = (cat: string | null) => {
    onDropTargetChange?.(cat);
  };

  const searchActive = !!search.trim();
  const tools = view.tools.filter((t) => matchesTool(t, search));
  const rootTools = tools.filter((t) => !t.category);
  const byCategory = new Map<string, ToolboxTool[]>();
  for (const t of tools) {
    if (!t.category) continue;
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }
  // Keep configured order; append any category present on tools but somehow
  // missing from the list (defensive — config keeps them in sync).
  const categories = [
    ...view.categories,
    ...[...byCategory.keys()].filter((c) => !view.categories.includes(c)),
  ];
  const visibleCategories = searchActive
    ? categories.filter((c) => (byCategory.get(c) ?? []).length > 0)
    : categories;

  const toggleCategory = (name: string) => {
    if (searchActive) return; // search shows everything
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      writeCollapsed(next);
      return next;
    });
  };

  const toggleOpen = () => {
    setOpen((prev) => {
      writeOpen(!prev);
      return !prev;
    });
  };

  const empty = view.tools.length === 0;
  const sectionOpen = open || searchActive;

  return (
    <div
      className={`toolbox-section${dropCategory === "" ? " drop-over-root" : ""}`}
      role="tree"
      aria-label="Toolbox"
      data-tour="toolbox"
      data-toolbox-drop=""
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        // Chrome/header/empty area → top level (rows set a more specific
        // target and stop propagation before this runs).
        setDropTarget("");
      }}
      onDragLeave={() => setDropTarget(null)}
    >
      <div className="toolbox-header" onContextMenu={onHeaderContextMenu}>
        <button type="button" className="toolbox-title" onClick={toggleOpen}>
          <span className="palette-twist" aria-hidden>
            {sectionOpen ? "▾" : "▸"}
          </span>
          <span className="toolbox-star" aria-hidden>
            ★
          </span>
          <span>Toolbox</span>
          <span className="palette-folder-count">{view.tools.length}</span>
        </button>
        <span className="toolbox-header-actions">
          <button
            type="button"
            className="toolbox-mini"
            title="Pin a tool (local .tox, URL / GitHub release, or package spec)"
            onClick={() => onAddTool("")}
          >
            ＋ Tool
          </button>
          <button
            type="button"
            className="toolbox-mini"
            title="Add a category (e.g. Generators, Utils, Show Control)"
            onClick={onAddCategory}
          >
            ＋ Category
          </button>
        </span>
      </div>
      {sectionOpen && empty && (
        <div className="toolbox-empty">
          Pin your go-to components here — local .tox files, GitHub releases / URLs, or package
          specs. Categories keep sets organized per task.
        </div>
      )}
      {sectionOpen && !empty && (
        <>
          {rootTools.map((tool) => (
            <ToolRow
              key={tool.id}
              tool={tool}
              depth={1}
              busy={busyIds.has(tool.id)}
              selectedPath={selectedPath}
              selectedRef={selectedRef}
              dropActive={false}
              onSelect={onSelect}
              onDragStart={onDragStart}
              onFetch={onFetch}
              onEditTool={onEditTool}
              onMoveTool={onMoveTool}
              onDropTarget={setDropTarget}
              onPlace={onPlace}
              placeTitle={placeTitle}
              onToolContextMenu={onToolContextMenu}
            />
          ))}
          {visibleCategories.map((cat) => {
            const catTools = byCategory.get(cat) ?? [];
            const catOpen = searchActive || !collapsed.has(cat);
            return (
              <div key={cat} className="palette-folder">
                <div
                  role="button"
                  tabIndex={0}
                  className={`palette-folder-row toolbox-category-row${
                    dropCategory === cat ? " drop-over" : ""
                  }`}
                  data-toolbox-drop={cat}
                  style={{ paddingLeft: 8 + 14, cursor: "pointer" }}
                  onClick={() => toggleCategory(cat)}
                  onContextMenu={
                    onCategoryContextMenu
                      ? (e) => onCategoryContextMenu(cat, e)
                      : undefined
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") toggleCategory(cat);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "copy";
                    setDropTarget(cat);
                  }}
                  onDragLeave={(e) => {
                    e.stopPropagation();
                    setDropTarget(null);
                  }}
                  title={`${cat} — a Toolbox category\nDrop .tox files here to pin them in this category`}
                >
                  <span className="palette-twist" aria-hidden>
                    {catOpen ? "▾" : "▸"}
                  </span>
                  <span className="palette-folder-name">{cat}</span>
                  <span className="toolbox-row-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="toolbox-mini"
                      title={`Pin a tool in "${cat}"`}
                      onClick={() => onAddTool(cat)}
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      className="toolbox-mini"
                      title="Edit category (rename, reorder, remove)"
                      onClick={() => onEditCategory(cat)}
                    >
                      ✎
                    </button>
                  </span>
                  <span className="palette-folder-count">{catTools.length}</span>
                </div>
                {catOpen &&
                  catTools.map((tool) => (
                    <ToolRow
                      key={tool.id}
                      tool={tool}
                      depth={2}
                      busy={busyIds.has(tool.id)}
                      selectedPath={selectedPath}
                      selectedRef={selectedRef}
                      dropActive={dropCategory === cat}
                      onSelect={onSelect}
                      onDragStart={onDragStart}
                      onFetch={onFetch}
                      onEditTool={onEditTool}
                      onMoveTool={onMoveTool}
                      onDropTarget={setDropTarget}
                      onPlace={onPlace}
                      placeTitle={placeTitle}
                      onToolContextMenu={onToolContextMenu}
                    />
                  ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
