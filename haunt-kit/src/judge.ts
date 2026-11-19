// Judge - pure function that produces RoomVerdicts from DetectorEvents

import { House, RoomVerdict, DetectorEvent } from "./types.js";

/**
 * Pure function that judges each room based on detector events.
 * Returns one RoomVerdict per room, in the same order as house.rooms.
 */
export function judge(events: DetectorEvent[], house: House): RoomVerdict[] {
  // Group events by roomId
  const eventsByRoom = new Map<string, DetectorEvent[]>();
  for (const event of events) {
    const roomEvents = eventsByRoom.get(event.roomId) || [];
    roomEvents.push(event);
    eventsByRoom.set(event.roomId, roomEvents);
  }

  // Build verdicts in the same order as house.rooms
  return house.rooms.map(room => {
    const roomEvents = eventsByRoom.get(room.id) || [];
    const evidence = roomEvents.flatMap(e => e.evidence);

    return {
      roomId: room.id,
      nameKo: room.nameKo,
      nameEn: room.nameEn,
      possessed: roomEvents.length > 0,
      evidence,
    };
  });
}