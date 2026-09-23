import type {CheckinPort} from '../checkin/service';
export interface ExternalCheckinEvent {externalEventId:string;participantId:string;occurredAt:string}
/** Phase 2 extension point. No EXE/scanner monitoring is implemented in phase 1. */
export class CheckinBridgeAdapter {constructor(private readonly checkin:CheckinPort){} handle(event:ExternalCheckinEvent){return this.checkin.checkIn(event.participantId);}}
