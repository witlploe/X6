import { KeyValue, Dom, Disposable } from '@antv/x6-common'
import { Rectangle } from '@antv/x6-geometry'
import { Model, Cell } from '../model'
import { View, CellView, NodeView, EdgeView } from '../view'
import { JobQueue, JOB_PRIORITY } from './queueJob'
import { FlagManager } from '../view/flag'
import { Graph } from '../graph'

export class Scheduler extends Disposable {
  public views: KeyValue<Scheduler.View> = {}
  protected zPivots: KeyValue<Comment>
  private graph: Graph
  private renderArea?: Rectangle
  private queue: JobQueue

  get model() {
    return this.graph.model
  }

  get container() {
    return this.graph.view.stage
  }

  constructor(graph: Graph) {
    super()
    this.queue = new JobQueue()
    this.graph = graph
    this.init()
  }

  protected init() {
    this.startListening()
  }

  protected startListening() {
    this.model.on('reseted', this.onModelReseted, this)
    this.model.on('cell:added', this.onCellAdded, this)
    this.model.on('cell:removed', this.onCellRemoved, this)
    this.model.on('cell:change:zIndex', this.onCellZIndexChanged, this)
    this.model.on('cell:change:visible', this.onCellVisibleChanged, this)
  }

  protected stopListening() {
    this.model.off('reseted', this.onModelReseted, this)
    this.model.off('cell:added', this.onCellAdded, this)
    this.model.off('cell:removed', this.onCellRemoved, this)
    this.model.off('cell:change:zIndex', this.onCellZIndexChanged, this)
    this.model.off('cell:change:visible', this.onCellVisibleChanged, this)
  }

  protected onModelReseted({ options }: Model.EventArgs['reseted']) {
    this.queue.clearJobs()
    this.removeZPivots()
    this.removeViews()
    this.renderViews(this.model.getCells(), options)
  }

  protected onCellAdded({ cell, options }: Model.EventArgs['cell:added']) {
    this.renderViews([cell], options)
  }

  protected onCellRemoved({ cell, options }: Model.EventArgs['cell:removed']) {
    const viewItem = this.views[cell.id]
    if (viewItem) {
      const view = viewItem.view
      this.requestViewUpdate(view, Scheduler.FLAG_REMOVE, options)
    }
  }

  protected onCellZIndexChanged({
    cell,
    options,
  }: Model.EventArgs['cell:change:zIndex']) {
    const viewItem = this.views[cell.id]
    if (viewItem) {
      this.requestViewUpdate(
        viewItem.view,
        Scheduler.FLAG_INSERT,
        options,
        JOB_PRIORITY.Update,
        true,
      )
    }
  }

  protected onCellVisibleChanged({
    cell,
    current,
  }: Model.EventArgs['cell:change:visible']) {
    this.toggleVisible(cell, !!current)
  }

  requestViewUpdate(
    view: CellView,
    flag: number,
    options: any = {},
    priority: JOB_PRIORITY = JOB_PRIORITY.Update,
    flush = true,
  ) {
    const id = view.cell.id
    const viewItem = this.views[id]

    if (!viewItem) {
      return
    }

    viewItem.flag = flag
    viewItem.options = options

    const priorAction = view.hasAction(flag, ['translate', 'resize', 'rotate'])
    if (view.isNodeView() && priorAction) {
      priority = JOB_PRIORITY.PRIOR // eslint-disable-line
      flush = false // eslint-disable-line
    }

    this.queue.queueJob({
      id,
      priority,
      cb: () => {
        this.renderViewInArea(view, flag, options)
      },
    })

    const effectedEdges = this.getEffectedEdges(view)
    effectedEdges.forEach((edge) => {
      this.requestViewUpdate(edge.view, edge.flag, options, priority, false)
    })

    if (flush) {
      this.flush()
    }
  }

  setRenderArea(area?: Rectangle) {
    this.renderArea = area
    this.flushWaittingViews()
  }

  isViewMounted(view: CellView) {
    if (view == null) {
      return false
    }

    const viewItem = this.views[view.cell.id]

    if (!viewItem) {
      return false
    }

    return viewItem.state === Scheduler.ViewState.MOUNTED
  }

  protected renderViews(cells: Cell[], options: any = {}) {
    cells.sort((c1, c2) => {
      if (c1.isNode() && c2.isEdge()) {
        return -1
      }
      return 0
    })

    cells.forEach((cell) => {
      const id = cell.id
      const views = this.views
      let flag = 0
      let viewItem = views[id]

      if (viewItem) {
        flag = Scheduler.FLAG_INSERT
      } else {
        const cellView = this.createCellView(cell)
        if (cellView) {
          cellView.graph = this.graph
          flag = Scheduler.FLAG_INSERT | cellView.getBootstrapFlag()
          viewItem = {
            view: cellView,
            flag,
            options,
            state: Scheduler.ViewState.CREATED,
          }
          this.views[id] = viewItem
        }
      }

      this.requestViewUpdate(
        viewItem.view,
        flag,
        options,
        cell.isNode() ? JOB_PRIORITY.RenderNode : JOB_PRIORITY.RenderEdge,
        false,
      )
    })

    this.flush()
  }

  protected renderViewInArea(view: CellView, flag: number, options: any = {}) {
    const cell = view.cell
    const id = cell.id
    const viewItem = this.views[id]

    if (!viewItem) {
      return
    }

    let result = 0
    if (this.isInRenderArea(view)) {
      result = this.updateView(view, flag, options)
      viewItem.flag = result
    } else {
      if (viewItem.state === Scheduler.ViewState.MOUNTED) {
        result = this.updateView(view, flag, options)
        viewItem.flag = result
      } else {
        viewItem.state = Scheduler.ViewState.WAITTING
      }
    }

    if (result) {
      console.log('left flag', result) // eslint-disable-line
    }
  }

  protected flush() {
    this.graph.options.async
      ? this.queue.queueFlush()
      : this.queue.queueFlushSync()
  }

  protected flushWaittingViews() {
    const ids = Object.keys(this.views)
    for (let i = 0, len = ids.length; i < len; i += 1) {
      const viewItem = this.views[ids[i]]
      if (viewItem && viewItem.state === Scheduler.ViewState.WAITTING) {
        const { view, flag, options } = viewItem
        const priority = view.cell.isNode()
          ? JOB_PRIORITY.RenderNode
          : JOB_PRIORITY.RenderEdge
        this.requestViewUpdate(view, flag, options, priority, false)
      }
    }

    this.flush()
  }

  protected updateView(view: View, flag: number, options: any = {}) {
    if (view == null) {
      return 0
    }

    if (CellView.isCellView(view)) {
      if (flag & Scheduler.FLAG_REMOVE) {
        this.removeView(view.cell as any)
        return 0
      }

      if (flag & Scheduler.FLAG_INSERT) {
        this.insertView(view)
        flag ^= Scheduler.FLAG_INSERT // eslint-disable-line
      }
    }

    if (!flag) {
      return 0
    }

    return view.confirmUpdate(flag, options)
  }

  protected insertView(view: CellView) {
    const viewItem = this.views[view.cell.id]
    if (viewItem) {
      const zIndex = view.cell.getZIndex()
      const pivot = this.addZPivot(zIndex)
      this.container.insertBefore(view.container, pivot)
      viewItem.state = Scheduler.ViewState.MOUNTED
    }
  }

  protected removeViews() {
    Object.keys(this.views).forEach((id) => {
      const viewItem = this.views[id]
      if (viewItem) {
        this.removeView(viewItem.view.cell)
      }
    })
    this.views = {}
  }

  protected removeView(cell: Cell) {
    const viewItem = this.views[cell.id]
    if (viewItem) {
      viewItem.view.remove()
      delete this.views[cell.id]
    }
    return viewItem.view
  }

  protected toggleVisible(cell: Cell, visible: boolean) {
    const edges = this.model.getConnectedEdges(cell)

    for (let i = 0, len = edges.length; i < len; i += 1) {
      const edge = edges[i]
      if (visible) {
        const source = edge.getSourceCell()
        const target = edge.getTargetCell()
        if (
          (source && !source.isVisible()) ||
          (target && !target.isVisible())
        ) {
          continue
        }
        this.toggleVisible(edge, true)
      } else {
        this.toggleVisible(edge, false)
      }
    }

    const viewItem = this.views[cell.id]
    if (viewItem) {
      Dom.css(viewItem.view.container, {
        display: visible ? 'unset' : 'none',
      })
    }
  }

  protected addZPivot(zIndex = 0) {
    if (this.zPivots == null) {
      this.zPivots = {}
    }

    const pivots = this.zPivots
    let pivot = pivots[zIndex]
    if (pivot) {
      return pivot
    }

    pivot = pivots[zIndex] = document.createComment(`z-index:${zIndex + 1}`)
    let neighborZ = -Infinity
    // eslint-disable-next-line
    for (const key in pivots) {
      const currentZ = +key
      if (currentZ < zIndex && currentZ > neighborZ) {
        neighborZ = currentZ
        if (neighborZ === zIndex - 1) {
          continue
        }
      }
    }

    const layer = this.container
    if (neighborZ !== -Infinity) {
      const neighborPivot = pivots[neighborZ]
      layer.insertBefore(pivot, neighborPivot.nextSibling)
    } else {
      layer.insertBefore(pivot, layer.firstChild)
    }
    return pivot
  }

  protected removeZPivots() {
    if (this.zPivots) {
      Object.keys(this.zPivots).forEach((z) => {
        const elem = this.zPivots[z]
        if (elem && elem.parentNode) {
          elem.parentNode.removeChild(elem)
        }
      })
    }
    this.zPivots = {}
  }

  protected createCellView(cell: Cell) {
    const options = { graph: this.graph }

    const view = cell.view
    if (view != null && typeof view === 'string') {
      const def = CellView.registry.get(view)
      if (def) {
        return new def(cell, options) // eslint-disable-line new-cap
      }

      return CellView.registry.onNotFound(view)
    }

    if (cell.isNode()) {
      return new NodeView(cell, options)
    }

    if (cell.isEdge()) {
      return new EdgeView(cell, options)
    }

    return null
  }

  protected getEffectedEdges(view: CellView) {
    const effectedEdges: { id: string; view: CellView; flag: number }[] = []
    const cell = view.cell
    const edges = this.model.getConnectedEdges(cell)

    for (let i = 0, n = edges.length; i < n; i += 1) {
      const edge = edges[i]
      const viewItem = this.views[edge.id]
      if (!viewItem) {
        continue
      }
      const edgeView = viewItem.view
      const flagLabels: FlagManager.Action[] = ['update']
      if (edge.getTargetCell() === cell) {
        flagLabels.push('target')
      }
      if (edge.getSourceCell() === cell) {
        flagLabels.push('source')
      }
      effectedEdges.push({
        id: edge.id,
        view: edgeView,
        flag: edgeView.getFlag(flagLabels),
      })
    }

    return effectedEdges
  }

  protected isInRenderArea(view: CellView) {
    return (
      !this.renderArea ||
      this.renderArea.isIntersectWithRect(view.cell.getBBox())
    )
  }

  @Disposable.dispose()
  dispose() {
    this.stopListening()
  }
}
export namespace Scheduler {
  export const FLAG_INSERT = 1 << 30
  export const FLAG_REMOVE = 1 << 29
  export const FLAG_RENDER = (1 << 26) - 1
}

export namespace Scheduler {
  export enum ViewState {
    CREATED,
    MOUNTED,
    WAITTING,
  }
  export interface View {
    view: CellView
    flag: number
    options: any
    state: ViewState
  }
}
