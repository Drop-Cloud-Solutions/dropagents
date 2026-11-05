export interface RecordedCall {
  adapter: string;
  method: string;
  args: unknown;
  timestamp: number;
}

export interface RecorderFilter {
  adapter?: string;
  method?: string;
}

export class Recorder {
  private readonly calls: RecordedCall[] = [];
  private readonly clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  append(adapter: string, method: string, args: unknown): void {
    this.calls.push({
      adapter,
      method,
      args,
      timestamp: this.clock()
    });
  }

  entries(): RecordedCall[] {
    return this.calls.slice();
  }

  findCalls(filter: RecorderFilter = {}): RecordedCall[] {
    return this.calls.filter((call) => {
      if (filter.adapter !== undefined && call.adapter !== filter.adapter) {
        return false;
      }
      if (filter.method !== undefined && call.method !== filter.method) {
        return false;
      }
      return true;
    });
  }

  reset(): void {
    this.calls.length = 0;
  }
}
