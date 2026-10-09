import { useEffect, useState } from "react";
import type { PaletteTreeFolder, PaletteTreeNode } from "./utils";
import { paletteTreeExpandIds } from "./utils";
import { PALETTE_EXPANDED_KEY } from "./uiPersist";

type Props = {
  roots: PaletteTreeFolder[];
  selectedPath: string | null;
  focusVersions: boolean;
  searchActive: boolean;
  selectedRef: React.MutableRefObject<HTMLElement | null>;
  onSelect: (path: string, missing: boolean) => void;
  onDragStart: (path: string, e: React.DragEvent) => void;
  /** Called while dragging files over an importable folder (rel path, '' = User Palette root). */
  onDropTargetChange?: (destFolderRel: string | null) => void;
  /** Load a .tox into a running session; absent = no eligible session. */
  onPlace?: (path: string) => void;
  placeTitle?: string;
  /** Extra diagnostics rendered inside the empty state (scan roots etc.). */
  emptyDetail?: React.ReactNode;
  /** Right-click on a .tox row. */
  onFileContextMenu?: (
    path: string,
    missing: boolean,
    acceptImports: boolean,
    e: React.MouseEvent,
  ) => void;
  /** Right-click on a folder row. */
  onFolderContextMenu?: (node: PaletteTreeFolder, e: React.MouseEvent) => void;
};

function readExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(PALETTE_EXPANDED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === "string"));
  } catch {
    /* ignore */
  }
  return new Set();
}

function writeExpanded(set: Set<string>) {
  try {
    localStorage.setItem(PALETTE_EXPANDED_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

function FolderRow({
  node,
  depth,
  expanded,
  toggle,
  selectedPath,
  focusVersions,
  selectedRef,
  onSelect,
  onDragStart,
  onDropTargetChange,
  dropFolderRel,
  setDropFolderRel,
  onPlace,
  placeTitle,
  onFileContextMenu,
  onFolderContextMenu,
}: {
  node: PaletteTreeFolder;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  selectedPath: string | null;
  focusVersions: boolean;
  selectedRef: React.MutableRefObject<HTMLElement | null>;
  onSelect: (path: string, missing: boolean) => void;
  onDragStart: (path: string, e: React.DragEvent) => void;
  onDropTargetChange?: (destFolderRel: string | null) => void;
  dropFolderRel: string | null;
  setDropFolderRel: (rel: string | null) => void;
  onPlace?: (path: string) => void;
  placeTitle?: string;
  onFileContextMenu?: (
    path: string,
    missing: boolean,
    acceptImports: boolean,
    e: React.MouseEvent,
  ) => void;
  onFolderContextMenu?: (node: PaletteTreeFolder, e: React.MouseEvent) => void;
}) {
  const open = expanded.has(node.id);
  const fileCount = countFiles(node);
  const dropActive =
    node.acceptImports && dropFolderRel !== null && dropFolderRel === node.relFolder;

  const setTarget = (rel: string | null) => {
    setDropFolderRel(rel);
    onDropTargetChange?.(rel);
  };

  return (
    <div className="palette-folder">
      <button
        type="button"
        className={`palette-folder-row${node.acceptImports ? " drop-target" : ""}${dropActive ? " drop-over" : ""}`}
        data-palette-drop={node.acceptImports ? node.relFolder : undefined}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => toggle(node.id)}
        onContextMenu={
          onFolderContextMenu ? (e) => onFolderContextMenu(node, e) : undefined
        }
        title={
          node.acceptImports
            ? `${node.id}\nDrop .tox files here to add to User Palette`
            : node.id
        }
        onDragOver={
          node.acceptImports
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
                setTarget(node.relFolder);
              }
            : undefined
        }
        onDragLeave={
          node.acceptImports
            ? (e) => {
                e.stopPropagation();
                setTarget(null);
              }
            : undefined
        }
      >
        <span className="palette-twist" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="palette-folder-name">{node.name}</span>
        <span className="palette-folder-count">{fileCount}</span>
      </button>
      {open &&
        node.children.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            selectedPath={selectedPath}
            focusVersions={focusVersions}
            selectedRef={selectedRef}
            onSelect={onSelect}
            onDragStart={onDragStart}
            onDropTargetChange={onDropTargetChange}
            dropFolderRel={dropFolderRel}
            setDropFolderRel={setDropFolderRel}
            onPlace={onPlace}
            placeTitle={placeTitle}
            onFileContextMenu={onFileContextMenu}
            onFolderContextMenu={onFolderContextMenu}
          />
        ))}
    </div>
  );
}

function FileRow({
  node,
  depth,
  selectedPath,
  focusVersions,
  selectedRef,
  onSelect,
  onDragStart,
  onDropTargetChange,
  setDropFolderRel,
  onPlace,
  placeTitle,
  onFileContextMenu,
}: {
  node: Extract<PaletteTreeNode, { kind: "file" }>;
  depth: number;
  selectedPath: string | null;
  focusVersions: boolean;
  selectedRef: React.MutableRefObject<HTMLElement | null>;
  onSelect: (path: string, missing: boolean) => void;
  onDragStart: (path: string, e: React.DragEvent) => void;
  onDropTargetChange?: (destFolderRel: string | null) => void;
  setDropFolderRel: (rel: string | null) => void;
  onPlace?: (path: string) => void;
  placeTitle?: string;
  onFileContextMenu?: (
    path: string,
    missing: boolean,
    acceptImports: boolean,
    e: React.MouseEvent,
  ) => void;
}) {
  const selected = node.path === selectedPath;
  const accept = !!node.acceptImports;
  const setTarget = (rel: string | null) => {
    setDropFolderRel(rel);
    onDropTargetChange?.(rel);
  };
  return (
    <div
      role="treeitem"
      draggable={!node.missing}
      ref={(el) => {
        if (selected) selectedRef.current = el;
      }}
      className={[
        "palette-file-row",
        selected ? "selected" : "",
        selected && focusVersions ? "focus-version" : "",
        node.missing ? "missing" : "",
        !node.missing ? "draggable-tox" : "",
        accept ? "drop-target" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-palette-drop={accept ? (node.relFolder ?? "") : undefined}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onSelect(node.path, node.missing)}
      onContextMenu={
        onFileContextMenu
          ? (e) => onFileContextMenu(node.path, node.missing, !!node.acceptImports, e)
          : undefined
      }
      onDragStart={(e) => onDragStart(node.path, e)}
      onDragOver={
        accept
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "copy";
              setTarget(node.relFolder ?? "");
            }
          : undefined
      }
      onDragLeave={
        accept
          ? (e) => {
              e.stopPropagation();
              setTarget(null);
            }
          : undefined
      }
      title={
        node.missing
          ? `${node.path} (missing)`
          : `${node.path}\nDrag into a TouchDesigner network${
              accept ? "\nDrop other .tox files here to import into this folder" : ""
            }`
      }
    >
      <span className="palette-twist spacer" aria-hidden />
      <span className="palette-file-icon" aria-hidden>
        ◆
      </span>
      <span className="palette-file-name">
        {node.name}
        {node.missing ? " (missing)" : ""}
      </span>
      {onPlace && !node.missing && (
        <span className="toolbox-row-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="toolbox-mini"
            title={placeTitle ?? "Place in a running session"}
            onClick={() => onPlace(node.path)}
          >
            ↳
          </button>
        </span>
      )}
      {node.mtime ? <span className="palette-file-mtime">{node.mtime}</span> : null}
    </div>
  );
}

function TreeNode(props: {
  node: PaletteTreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  selectedPath: string | null;
  focusVersions: boolean;
  selectedRef: React.MutableRefObject<HTMLElement | null>;
  onSelect: (path: string, missing: boolean) => void;
  onDragStart: (path: string, e: React.DragEvent) => void;
  onDropTargetChange?: (destFolderRel: string | null) => void;
  dropFolderRel: string | null;
  setDropFolderRel: (rel: string | null) => void;
  onPlace?: (path: string) => void;
  placeTitle?: string;
  onFileContextMenu?: (
    path: string,
    missing: boolean,
    acceptImports: boolean,
    e: React.MouseEvent,
  ) => void;
  onFolderContextMenu?: (node: PaletteTreeFolder, e: React.MouseEvent) => void;
}) {
  if (props.node.kind === "folder") {
    return <FolderRow {...props} node={props.node} />;
  }
  return <FileRow {...props} node={props.node} />;
}

function countFiles(node: PaletteTreeFolder): number {
  let n = 0;
  for (const c of node.children) {
    if (c.kind === "file") n += 1;
    else n += countFiles(c);
  }
  return n;
}

export default function PaletteTree({
  roots,
  selectedPath,
  focusVersions,
  searchActive,
  selectedRef,
  onSelect,
  onDragStart,
  onDropTargetChange,
  onPlace,
  placeTitle,
  emptyDetail,
  onFileContextMenu,
  onFolderContextMenu,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const saved = readExpanded();
    if (saved.size) return saved;
    return new Set(roots.map((r) => r.id));
  });
  const [dropFolderRel, setDropFolderRel] = useState<string | null>(null);

  useEffect(() => {
    if (searchActive) {
      setExpanded(new Set(paletteTreeExpandIds(roots)));
      return;
    }
    const saved = readExpanded();
    if (saved.size) {
      setExpanded(saved);
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const r of roots) {
        if (!next.has(r.id)) {
          next.add(r.id);
          changed = true;
        }
      }
      if (!changed) return prev;
      writeExpanded(next);
      return next;
    });
  }, [roots, searchActive]);

  const toggle = (id: string) => {
    if (searchActive) {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeExpanded(next);
      return next;
    });
  };

  if (roots.length === 0) {
    return (
      <div
        className="empty palette-drop-empty"
        data-palette-drop=""
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          onDropTargetChange?.("");
        }}
        onDragLeave={() => onDropTargetChange?.(null)}
      >
        <div>
          No .tox components found. Drop .tox files onto this panel to add them to User Palette,
          or put files in Documents/Derivative/Palette.
        </div>
        {emptyDetail}
      </div>
    );
  }

  return (
    <div
      className={`panel palette-tree${dropFolderRel !== null ? " is-dropping" : ""}`}
      role="tree"
      aria-label="Palette"
      data-palette-drop=""
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        // Hovering panel chrome → User Palette root (unless a folder set a more specific target)
        if (dropFolderRel === null) onDropTargetChange?.("");
      }}
      onDragLeave={() => {
        setDropFolderRel(null);
        onDropTargetChange?.(null);
      }}
    >
      {roots.map((root) => (
        <TreeNode
          key={root.id}
          node={root}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          selectedPath={selectedPath}
          focusVersions={focusVersions}
          selectedRef={selectedRef}
          onSelect={onSelect}
          onDragStart={onDragStart}
          onDropTargetChange={onDropTargetChange}
          dropFolderRel={dropFolderRel}
          setDropFolderRel={setDropFolderRel}
          onPlace={onPlace}
          placeTitle={placeTitle}
          onFileContextMenu={onFileContextMenu}
          onFolderContextMenu={onFolderContextMenu}
        />
      ))}
    </div>
  );
}
