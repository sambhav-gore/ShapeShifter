import { MathUtil, Point } from '../scripts/common';
import { LayerUtil } from '../scripts/layers';
import { ProjectionOntoPath } from '../scripts/paths';
import {
  ActionSource,
  HoverType,
  SetSelections,
  State,
  Store,
  TogglePointSelection,
  ToggleSegmentSelections,
  ToggleSubPathSelection,
  UpdateActivePathBlock,
} from '../store';
import { CanvasOverlayDirective } from './canvasoverlay.directive';
import * as _ from 'lodash';

/**
 * Helper class that tracks information about a user's mouse gesture, allowing
 * for the selection of path points, segments, and shapes.
 */
export class SelectionHelper {
  private readonly actionSource: ActionSource;
  private readonly store: Store<State>;

  // Holds a reference to the currently selected split point, which
  // may or may not begin to drag.
  private currentDraggableSplitIndex: { subIdx: number, cmdIdx: number } | undefined;
  private projectionOntoPath: ProjectionOntoPath;
  private isDragTriggered_ = false;
  private lastKnownMouseLocation: Point;
  private initialMouseDown: Point;

  constructor(private readonly component: CanvasOverlayDirective) {
    this.actionSource = component.actionSource;
    this.store = component.store;
  }

  onMouseDown(mouseDown: Point, isShiftOrMetaPressed: boolean) {
    this.initialMouseDown = mouseDown;
    this.lastKnownMouseLocation = mouseDown;

    const hitResult = this.performHitTest(mouseDown);
    if (hitResult.isEndPointHit) {
      const { subIdx, cmdIdx, cmd } = this.findHitPoint(hitResult.endPointHits);
      if (cmd.isSplitPoint()) {
        // Then a click has occurred on top of a split point.
        // Don't select the point yet because the user might want
        // to drag it to a different location.
        this.currentDraggableSplitIndex = { subIdx, cmdIdx };
      } else {
        // Then a click has occurred on top of a non-split point.
        this.store.dispatch(
          new TogglePointSelection(this.actionSource, subIdx, cmdIdx, isShiftOrMetaPressed));
      }
      return;
    }

    if (this.component.activePathLayer.isFilled() && hitResult.isSegmentHit) {
      const { subIdx, cmdIdx, cmd } = this.findHitSegment(hitResult.segmentHits);
      if (cmd.isSplitSegment()) {
        this.store.dispatch(new ToggleSegmentSelections(this.actionSource, [{ subIdx, cmdIdx }]));
        return;
      }
    }

    if (hitResult.isSegmentHit || hitResult.isShapeHit) {
      const hits = hitResult.isShapeHit ? hitResult.shapeHits : hitResult.segmentHits;
      const { subIdx } = this.findHitSubPath(hits);
      this.store.dispatch(new ToggleSubPathSelection(this.actionSource, subIdx));
    } else if (!isShiftOrMetaPressed) {
      // If the mouse down event didn't result in a hit, then
      // clear any existing selections, but only if the user isn't in
      // the middle of selecting multiple points at once.
      this.store.dispatch(new SetSelections([]));
    }
  }

  onMouseMove(mouseMove: Point) {
    this.lastKnownMouseLocation = mouseMove;
    if (this.currentDraggableSplitIndex) {
      const distance = MathUtil.distance(this.initialMouseDown, mouseMove);
      if (this.component.dragTriggerTouchSlop < distance) {
        this.isDragTriggered_ = true;
      }
    }
    if (this.isDragTriggered_) {
      this.projectionOntoPath =
        this.calculateProjectionOntoPath(
          mouseMove, this.currentDraggableSplitIndex.subIdx);
    } else {
      this.checkForHovers(mouseMove);
    }
    this.component.draw();
  }

  onMouseUp(mouseUp: Point, isShiftOrMetaPressed: boolean) {
    this.lastKnownMouseLocation = mouseUp;
    if (this.isDragTriggered_) {
      const projOntoPath = this.projectionOntoPath;

      // TODO: Make this user experience better. There could be other subIdxs that we could use.
      const { subIdx: newSubIdx, cmdIdx: newCmdIdx } = projOntoPath;
      const { subIdx: oldSubIdx, cmdIdx: oldCmdIdx } = this.currentDraggableSplitIndex;
      if (newSubIdx === oldSubIdx) {
        const activeLayer = this.component.activePathLayer;
        const startingPath = activeLayer.pathData;
        let pathMutator = startingPath.mutate();

        // Note that the order is important here, as it preserves the command indices.
        if (newCmdIdx > oldCmdIdx) {
          pathMutator.splitCommand(newSubIdx, newCmdIdx, projOntoPath.projection.t);
          pathMutator.unsplitCommand(oldSubIdx, oldCmdIdx);
        } else if (newCmdIdx < oldCmdIdx) {
          pathMutator.unsplitCommand(oldSubIdx, oldCmdIdx);
          pathMutator.splitCommand(newSubIdx, newCmdIdx, projOntoPath.projection.t);
        } else {
          // Unsplitting will cause the projection t value to change, so recalculate the
          // projection before the split.
          // TODO: improve this API somehow... having to set the active layer here is kind of hacky
          activeLayer.pathData = pathMutator.unsplitCommand(oldSubIdx, oldCmdIdx).build();
          const tempProjOntoPath = this.calculateProjectionOntoPath(mouseUp);
          if (oldSubIdx === tempProjOntoPath.subIdx) {
            pathMutator.splitCommand(
              tempProjOntoPath.subIdx, tempProjOntoPath.cmdIdx, tempProjOntoPath.projection.t);
          } else {
            // If for some reason the projection subIdx changes after the unsplit, we have no
            // choice but to give up.
            // TODO: Make this user experience better. There could be other subIdxs that we could use.
            pathMutator = startingPath.mutate();
          }
        }

        // Notify the global layer state service about the change and draw.
        // Clear any existing selections and/or hovers as well.
        this.component.hoverService.setHover(undefined);
        this.store.dispatch(new SetSelections([]));
        this.reset();

        this.store.dispatch(
          new UpdateActivePathBlock(
            this.actionSource, pathMutator.build()));
      }
    } else if (this.currentDraggableSplitIndex) {
      const hitResult = this.performHitTest(mouseUp);
      if (!hitResult.isHit) {
        this.store.dispatch(new SetSelections([]));
      } else if (hitResult.isEndPointHit) {
        const { subIdx, cmdIdx } = this.findHitPoint(hitResult.endPointHits);
        this.store.dispatch(
          new TogglePointSelection(this.actionSource, subIdx, cmdIdx, isShiftOrMetaPressed));
      } else if (hitResult.isSegmentHit || hitResult.isShapeHit) {
        const hits = hitResult.isShapeHit ? hitResult.shapeHits : hitResult.segmentHits;
        const { subIdx } = this.findHitSubPath(hits);
        this.store.dispatch(new ToggleSubPathSelection(this.actionSource, subIdx));
      }
    }

    this.reset();
    this.checkForHovers(mouseUp);
    this.component.draw();
  }

  onMouseLeave(mouseLeave: Point) {
    this.lastKnownMouseLocation = mouseLeave;
    this.reset();
    this.component.hoverService.setHover(undefined);
    this.component.draw();
  }

  private performHitTest(mousePoint: Point) {
    return this.component.performHitTest(mousePoint);
  }

  private reset() {
    this.initialMouseDown = undefined;
    this.projectionOntoPath = undefined;
    this.currentDraggableSplitIndex = undefined;
    this.isDragTriggered_ = false;
    this.lastKnownMouseLocation = undefined;
  }

  isDragTriggered() {
    return this.isDragTriggered_;
  }

  getDraggableSplitIndex() {
    return this.currentDraggableSplitIndex;
  }

  getProjectionOntoPath() {
    return this.projectionOntoPath;
  }

  getLastKnownMouseLocation() {
    return this.lastKnownMouseLocation;
  }

  private checkForHovers(mousePoint: Point) {
    if (this.currentDraggableSplitIndex) {
      // Don't broadcast new hover events if a point has been selected.
      return;
    }
    const hitResult = this.performHitTest(mousePoint);
    if (!hitResult.isHit) {
      this.component.hoverService.setHover(undefined);
      return;
    }
    if (hitResult.isEndPointHit) {
      const { subIdx, cmdIdx } = this.findHitPoint(hitResult.endPointHits);
      this.component.hoverService.setHover({
        type: HoverType.Point,
        source: this.actionSource,
        subIdx,
        cmdIdx,
      });
      return;
    }
    if (hitResult.isSegmentHit) {
      if (this.component.activePathLayer.isFilled()) {
        const { subIdx, cmdIdx } = this.findHitSegment(hitResult.segmentHits);
        if (this.component.activePath.getCommand(subIdx, cmdIdx).isSplitSegment()) {
          this.component.hoverService.setHover({
            type: HoverType.Segment,
            source: this.actionSource,
            subIdx,
            cmdIdx,
          });
          return;
        }
      } else if (this.component.activePathLayer.isStroked()) {
        const { subIdx } = this.findHitSegment(hitResult.segmentHits);
        this.component.hoverService.setHover({
          type: HoverType.SubPath,
          source: this.actionSource,
          subIdx,
        });
        return;
      }
    }
    if (hitResult.isShapeHit && this.component.activePathLayer.isFilled()) {
      const { subIdx } = this.findHitSubPath(hitResult.shapeHits);
      this.component.hoverService.setHover({
        type: HoverType.SubPath,
        source: this.actionSource,
        subIdx,
      });
      return;
    }
  }

  private findHitSubPath(hits: ReadonlyArray<{ subIdx: number }>) {
    const infos = hits.map(index => {
      const { subIdx } = index;
      return { subIdx, subPath: this.component.activePath.getSubPath(subIdx) };
    });
    const lastSplitIndex = _.findLastIndex(infos, info => info.subPath.isSplit());
    return infos[lastSplitIndex < 0 ? infos.length - 1 : lastSplitIndex];
  }

  private findHitSegment(hits: ReadonlyArray<{ subIdx: number, cmdIdx: number }>) {
    const infos = hits.map(index => {
      const { subIdx, cmdIdx } = index;
      return { subIdx, cmdIdx, cmd: this.component.activePath.getCommand(subIdx, cmdIdx) };
    });
    const lastSplitIndex = _.findLastIndex(infos, info => info.cmd.isSplitSegment());
    return infos[lastSplitIndex < 0 ? infos.length - 1 : lastSplitIndex];
  }

  private findHitPoint(hits: ReadonlyArray<{ subIdx: number, cmdIdx: number }>) {
    const infos = hits.map(index => {
      const { subIdx, cmdIdx } = index;
      return { subIdx, cmdIdx, cmd: this.component.activePath.getCommand(subIdx, cmdIdx) };
    });
    const lastSplitIndex = _.findLastIndex(infos, info => info.cmd.isSplitPoint());
    return infos[lastSplitIndex < 0 ? infos.length - 1 : lastSplitIndex];
  }

  /**
  * Calculates the projection onto the path with the specified path ID.
  * The resulting projection is our way of determining the on-curve point
  * closest to the specified off-curve mouse point.
  */
  private calculateProjectionOntoPath(mousePoint: Point, restrictToSubIdx?: number) {
    const transform =
      LayerUtil.getFlattenedTransformForLayer(
        this.component.vectorLayer,
        this.component.activePathLayer.id);
    const transformedMousePoint =
      MathUtil.transformPoint(mousePoint, transform.invert());
    const projInfo =
      this.component.activePath.project(transformedMousePoint, restrictToSubIdx);
    if (!projInfo) {
      return undefined;
    }
    return {
      subIdx: projInfo.subIdx,
      cmdIdx: projInfo.cmdIdx,
      projection: projInfo.projection,
    };
  }
}
