import { EventEmitter } from 'events';

export interface RuntimeEvent {
  type: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

export class RuntimeBridge extends EventEmitter {
  private connected = false;

  connect(): void {
    this.connected = true;
    this.emit('connected', { status: 'connected' });
  }

  disconnect(): void {
    this.connected = false;
    this.emit('disconnected', { status: 'disconnected' });
  }

  isConnected(): boolean {
    return this.connected;
  }

  publish(event: RuntimeEvent): void {
    if (!this.connected) {
      return;
    }

    this.emit('event', event);
  }
}

export const runtimeBridge = new RuntimeBridge();
