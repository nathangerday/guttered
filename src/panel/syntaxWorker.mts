import { common, createLowlight } from 'lowlight';
import type { Root } from 'hast';
import { syntaxLanguage, syntaxLines, type SyntaxRequest, type SyntaxResponse } from './syntax.js';

const highlighter = createLowlight(common);
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<SyntaxRequest>) => void;
  postMessage(message: SyntaxResponse): void;
};
let cache: { key: string; old: Root; current: Root } | undefined;
scope.onmessage = ({ data }) => {
  const response: SyntaxResponse = { id: data.id, old: {}, current: {} };
  const language = syntaxLanguage(data.language);
  if (highlighter.registered(language)) {
    try {
      if (cache?.key !== data.key) {
        cache = { key: data.key,
          old: highlighter.highlight(language, data.old.replace(/\r\n/g, '\n')),
          current: highlighter.highlight(language, data.current.replace(/\r\n/g, '\n')) };
      }
      response.old = syntaxLines(cache.old, data.oldLines);
      response.current = syntaxLines(cache.current, data.currentLines);
    } catch { cache = undefined; } // Keep the readable plain diff if a grammar cannot process this source.
  } else cache = undefined;
  scope.postMessage(response);
};
