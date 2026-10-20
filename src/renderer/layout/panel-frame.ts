// What a panel's own header needs from the layout it sits in, so a panel can be dragged by its header and has the same
// menu as its tab (Move to, Close). Provided around each panel by the layout view; a panel outside a layout has none.
import { createContext } from "preact"

/** What a dragged tab or header carries: the panel's id */
export const PanelDragType = "application/x-n2-panel"

export interface PanelFrame {
  /** The panel's id, for the header to name in a drag */
  id: string
  dragStart(e: DragEvent): void
  dragEnd(): void
  /** Opens the panel's menu (Move to, Close) at the pointer */
  contextMenu(e: MouseEvent): void
}

export const PanelFrameContext = createContext<PanelFrame | null>(null)
