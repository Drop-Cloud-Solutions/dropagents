import type { ChatGateway } from '../../core/ports';
import type { Recorder } from './recorder';

/**
 * Fake ChatGateway used by Phase 0 bootstrap and integration tests.
 *
 * `notify` is a no-op for state purposes. The Phase 0 echo flow has no
 * human-in-the-loop step, so the gateway exists only to satisfy the port
 * wiring — there is nothing meaningful to send.
 *
 * When a {@link Recorder} is supplied, every call appends a structured
 * entry under the adapter name `fake-chat-gateway`. Observable behaviour
 * is unchanged: the method still resolves to `undefined`.
 */

export const FAKE_CHAT_GATEWAY_ADAPTER = 'fake-chat-gateway';

export class FakeChatGateway implements ChatGateway {
  private readonly recorder?: Recorder;

  constructor(options: { recorder?: Recorder } = {}) {
    this.recorder = options.recorder;
  }

  async notify(channel: string, message: string): Promise<void> {
    this.recorder?.append(FAKE_CHAT_GATEWAY_ADAPTER, 'notify', { channel, message });
  }
}
