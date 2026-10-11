import type { PanelView } from './model';
import type { SyntaxRequest, SyntaxResponse, SyntaxToken } from './syntax';

/** A timed, local worker keeps grammars and large source files off the UI thread. */
export class SyntaxHighlighting {
  private worker?: Worker;
  private url?: Promise<string>;
  private key = '';
  private sequence = 0;
  private pending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private result?: SyntaxResponse;
  private disposed = false;

  constructor(private readonly resource: string, private readonly paint: () => void) {}

  update(view: Pick<PanelView, 'rows' | 'syntax'>): void {
    const oldLines = [...new Set(view.rows.flatMap(row => row.old ? [row.old.number] : []))];
    const currentLines = [...new Set(view.rows.flatMap(row => row.current ? [row.current.number] : []))];
    const key = view.syntax ? `${view.syntax.key}:${oldLines.join(',')}:${currentLines.join(',')}` : '';
    if (key === this.key) return;
    this.key = key;
    this.result = undefined;
    ++this.sequence;
    clearTimeout(this.timer);
    // Cancel an older, unfinished tokenization instead of queuing stale edits.
    if (this.pending) this.stop();
    if (!view.syntax || this.disposed) return;
    this.pending = true;
    const request: SyntaxRequest = { ...view.syntax, id: this.sequence, oldLines, currentLines };
    this.timer = setTimeout(() => this.fail(request.id), 1500);
    void this.start(request).catch(() => this.fail(request.id));
  }

  tokens(side: 'old' | 'current', line: number): SyntaxToken[] | undefined {
    return this.result?.[side][line];
  }

  private async start(request: SyntaxRequest): Promise<void> {
    // VS Code webviews support workers loaded from a blob, not a resource URI.
    this.url ??= fetch(this.resource).then(async response => {
      if (!response.ok) throw new Error('Syntax worker could not be loaded.');
      return URL.createObjectURL(await response.blob());
    });
    const url = await this.url;
    if (this.disposed || request.id !== this.sequence || !this.pending) return;
    if (!this.worker) {
      const worker = this.worker = new Worker(url);
      worker.onmessage = ({ data }: MessageEvent<SyntaxResponse>) => {
        if (data.id !== this.sequence || !this.pending) return;
        clearTimeout(this.timer);
        this.pending = false;
        this.result = data;
        this.paint();
      };
      worker.onerror = () => { if (this.worker === worker) this.fail(this.sequence); };
    }
    this.worker.postMessage(request);
  }

  private fail(id: number): void {
    if (id !== this.sequence) return;
    clearTimeout(this.timer);
    this.stop();
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.pending = false;
  }

  dispose(): void {
    this.disposed = true;
    ++this.sequence;
    clearTimeout(this.timer);
    this.stop();
    void this.url?.then(url => URL.revokeObjectURL(url)).catch(() => {});
  }
}
