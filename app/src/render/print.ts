import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './print.css';
import { renderDocument, type RenderPayload } from './renderer';
declare global {
  interface Window {
    __RENDER_PAYLOAD?: RenderPayload;
    __RENDER_DONE?: { pageCount: number; warning: string | null };
    __RENDER_ERROR?: string;
    renderRundown: (p: RenderPayload) => Promise<void>;
  }
}
window.renderRundown = async (p) => {
  window.__RENDER_DONE = undefined;
  window.__RENDER_ERROR = undefined;
  try {
    const result = await renderDocument(p);
    document.getElementById('print-root')!.innerHTML = result.html;
    const style = document.createElement('style');
    style.textContent = `@page {size:A4 ${p.template.orientation};margin:0}`;
    document.head.append(style);
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
    window.__RENDER_DONE = { pageCount: result.pageCount, warning: result.warning };
  } catch (e) {
    window.__RENDER_ERROR = String(e);
    throw e;
  }
};
if (window.__RENDER_PAYLOAD) void window.renderRundown(window.__RENDER_PAYLOAD);
