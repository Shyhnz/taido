/**
 * Drag sensors shared by the window's DndContext and the subtasks' one.
 *
 * Mac: pointer (mouse, trackpad) and keyboard. Web app (`features.touchDrag`), on a phone or
 * a computer: the same, plus a long press for fingers; the pointer sensor then ignores touch
 * pointers, or a swipe meant to scroll the list would drag the row under the finger.
 */

import {
  type DraggableSyntheticListeners,
  KeyboardSensor,
  PointerSensor,
  type PointerSensorOptions,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type {
  PointerEvent,
  MouseEvent as ReactMouseEvent,
  TouchEventHandler,
} from "react";
import { features } from "../../lib/features";

/** Hold time before a touched row, project or group header follows the finger. */
export const LONG_PRESS_MS = 300;

/** The pointer sensor for mice, pens and trackpads only: fingers go through `TouchSensor`. */
export class NonTouchPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (event: PointerEvent, options: PointerSensorOptions): boolean =>
        event.nativeEvent.pointerType !== "touch" &&
        (PointerSensor.activators[0]?.handler(event, options) ?? false),
    },
  ];
}

/** Sensors of a DndContext; `distance` is the pointer travel that starts a drag. */
export function useDragSensors(distance: number) {
  const pointer = useSensor(
    features.touchDrag ? NonTouchPointerSensor : PointerSensor,
    { activationConstraint: { distance } },
  );
  const keyboard = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  });
  // A swipe before the delay still scrolls the list.
  const touch = useSensor(TouchSensor, {
    activationConstraint: { delay: LONG_PRESS_MS, tolerance: 8 },
  });
  return useSensors(
    features.dragAndDrop ? pointer : undefined,
    features.dragAndDrop ? keyboard : undefined,
    features.touchDrag ? touch : undefined,
  );
}

/**
 * Splits dnd-kit's listeners: the grip keeps the mouse and keyboard ones, the item itself
 * gets the long press (`onTouchStart`, web app only; `undefined` elsewhere).
 */
export function splitTouchListeners(listeners: DraggableSyntheticListeners): {
  grip: DraggableSyntheticListeners;
  onTouchStart: TouchEventHandler<HTMLElement> | undefined;
} {
  const { onTouchStart, ...grip } = listeners ?? {};
  return {
    grip,
    onTouchStart: features.touchDrag
      ? (onTouchStart as TouchEventHandler<HTMLElement> | undefined)
      : undefined,
  };
}

/**
 * True for the context menu a long press raises on a touch screen (Chrome sends it as a
 * touch PointerEvent): that press picks the item up instead. A right click still opens
 * the menu, on the web app too.
 */
export function isTouchContextMenu(event: ReactMouseEvent): boolean {
  if (!features.touchDrag) return false;
  const native = event.nativeEvent as globalThis.PointerEvent;
  if (native.pointerType === "touch") return true;
  // Browsers that send a plain MouseEvent: a finger is still down (or just lifted).
  return performance.now() - lastTouchAt < 1500;
}

let lastTouchAt = Number.NEGATIVE_INFINITY;
if (features.touchDrag && typeof window !== "undefined") {
  const touched = () => {
    lastTouchAt = performance.now();
  };
  window.addEventListener("touchstart", touched, {
    passive: true,
    capture: true,
  });
  window.addEventListener("touchend", touched, {
    passive: true,
    capture: true,
  });
}
