import type { ComputedItem, Template, Person, ColumnKey } from '../types';
import { filterItems, fitPagination, formatDuration, itemGapLabel, time } from './domain';
export interface RenderPayload {
  tenant: { name: string; logoUrl?: string };
  event: { name: string; timeZone: string; logoUrl?: string };
  session: { name: string; subtitle?: string; startAt: string };
  items: ComputedItem[];
  template: Template;
  recipient: Pick<Person, 'id' | 'name' | 'role'> | null;
  meta?: { copyIndex?: number; copyCount?: number };
}
export interface RenderResult {
  html: string;
  pageCount: number;
  warning: string | null;
}
export const labels: Record<ColumnKey, string> = {
  start: 'Start',
  duration: 'Duration',
  end: 'End',
  number: '#',
  title: 'Title',
  category: 'Category',
  people: 'People',
  notes: 'Notes',
  script: 'Script',
  audio: 'Audio',
  video: 'Video',
  lighting: 'Lighting',
  camera: 'Camera',
  slides: 'Slides',
  imageSlide: 'Image slide',
};
const escape = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
function safeImage(url: string | undefined) {
  return url && /^(https?:\/\/|data:image\/(png|jpeg|webp);base64,)/.test(url) ? escape(url) : '';
}
function header(p: RenderPayload) {
  const value = (key: string) => {
    switch (key) {
      case 'sessionName':
        return `<h1>${escape(p.session.name)}</h1>`;
      case 'eventName':
        return `<div>${escape(p.event.name)}</div>`;
      case 'sessionSubtitle':
        return p.session.subtitle
          ? `<div class="print-subtitle">${escape(p.session.subtitle)}</div>`
          : '';
      case 'personName':
        return `<div class="print-prepared">Prepared for</div><h2>${escape(p.recipient?.name ?? '[Person name]')}</h2>`;
      case 'sessionDateTime':
        return `<div>${escape(new Intl.DateTimeFormat('en-AU', { timeZone: p.event.timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(p.session.startAt)))} · ${escape(time(p.session.startAt, 0, p.event.timeZone, true))}</div>`;
      case 'logo': {
        const url = safeImage(p.event.logoUrl || p.tenant.logoUrl);
        return url
          ? `<img class="print-logo" src="${url}" alt="${escape(p.tenant.name)}"/>`
          : `<div class="print-logo-text">${escape(p.tenant.name)}</div>`;
      }
      default:
        return '';
    }
  };
  return `<header class="print-header">${(['left', 'right'] as const)
    .map(
      (align) =>
        `<div class="print-header-${align}">${(
          [
            'logo',
            'sessionName',
            'eventName',
            'sessionSubtitle',
            'personName',
            'sessionDateTime',
          ] as const
        )
          .filter((key) => p.template.header[key].show && p.template.header[key].align === align)
          .map((key) => value(key))
          .join('')}</div>`,
    )
    .join('')}</header>`;
}
function cell(p: RenderPayload, item: ComputedItem, key: ColumnKey): string {
  if (key === 'start' || key === 'end')
    return escape(
      time(p.session.startAt, key === 'start' ? item.startSec : item.endSec, p.event.timeZone),
    );
  if (key === 'duration') return formatDuration(item.durationSec);
  if (key === 'number') return String(item.number);
  if (key === 'category') return escape(item.category.name);
  if (key === 'people') return escape(item.people.map((p) => p.name).join(', '));
  if (key === 'imageSlide') {
    if (!item.imageSlide) return '';
    const url = safeImage(item.imageSlide.url);
    return url
      ? `<img class="print-slide" src="${url}" alt="${escape(item.imageSlide.name)}"/>`
      : `<div class="print-slide-placeholder">${escape(item.imageSlide.name)}</div>`;
  }
  if (['audio', 'video', 'lighting', 'camera', 'slides'].includes(key))
    return escape(item.av[key as keyof typeof item.av] ?? '');
  return escape(item[key as 'title' | 'notes' | 'script'] ?? '');
}
function columns(p: RenderPayload) {
  const visible = p.template.columns.filter((c) => c.visible);
  return p.template.itemStyle === 'table' && visible.some((c) => c.key === 'title')
    ? visible.filter((c) => c.key !== 'category')
    : visible;
}
function grid(p: RenderPayload) {
  return columns(p)
    .map((c) => (/^\d+(\.\d+)?(px|fr)$/.test(c.width) ? c.width : 'minmax(0, 1fr)'))
    .join(' ');
}
function tableHead(p: RenderPayload) {
  return p.template.itemStyle === 'table'
    ? `<div class="print-table-head" style="grid-template-columns:${grid(p)}">${columns(p)
        .map(
          (c) =>
            `<div>${c.key === 'duration' ? 'Dur' : c.key === 'title' ? 'Item' : labels[c.key]}</div>`,
        )
        .join('')}</div>`
    : '';
}
function block(p: RenderPayload, item: ComputedItem, continuation = false) {
  const cols = columns(p),
    style = p.template.itemStyle,
    recipientClass = item.isRecipientItem ? ' recipient-row' : '';
  if (item.context) {
    const previous = p.items[item.number - 2];
    const before = !previous?.personIds.includes(p.recipient?.id ?? '');
    return `<div class="print-context"><span class="mono">${time(p.session.startAt, item.startSec, p.event.timeZone)}</span><small>${before ? 'Before' : 'After'}</small><b>${escape(item.title)}</b><span>${escape(item.people.map((p) => p.name).join(', '))} · ${formatDuration(item.durationSec)}</span></div>`;
  }
  if (style === 'cards' || style === 'denseCards') {
    const visible = (key: ColumnKey) => cols.some((c) => c.key === key);
    const meta = [
      visible('category') ? escape(item.category.name) : '',
      visible('number') ? `Item ${item.number}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const timing = cols
      .filter((c) => ['start', 'duration', 'end'].includes(c.key))
      .map(
        (c) =>
          `<div><small>${labels[c.key]}</small><span class="mono">${cell(p, item, c.key)}</span></div>`,
      )
      .join('');
    const rest = cols
      .filter((c) => !['category', 'number', 'title', 'start', 'duration', 'end'].includes(c.key))
      .map((c) => {
        const value = cell(p, item, c.key);
        return value
          ? `<div class="print-field field-${c.key}"><small>${labels[c.key]}</small><div>${value}</div></div>`
          : '';
      })
      .join('');
    return `<article class="print-item print-card${style === 'denseCards' ? ' print-dense-card' : ''}${recipientClass}"><div class="print-card-heading"><div><small class="print-card-meta">${meta}</small>${visible('title') ? `<h2>${escape(item.title)}</h2>` : ''}</div><div class="print-card-timing">${timing}</div></div>${rest}</article>`;
  }
  if (style === 'table')
    return `<div class="print-table-row${recipientClass}" style="grid-template-columns:${grid(p)}">${cols.map((c) => `<div class="print-cell ${['start', 'duration', 'end'].includes(c.key) ? 'mono' : ''}">${c.key === 'title' ? `<b>${cell(p, item, c.key)}</b>${p.template.columns.some((c) => c.key === 'category' && c.visible) ? `<small class="print-category">${escape(item.category.name)}</small>` : ''}` : cell(p, item, c.key)}</div>`).join('')}</div>`;
  return `<article class="print-item ${style === 'compact' ? 'print-compact' : style === 'cueCard' ? 'print-cue' : 'print-card'}${recipientClass}">${cols
    .map((c) => {
      const value = cell(p, item, c.key);
      if (!value) return '';
      if (c.key === 'title') return `<h2>${value}${continuation ? ' (cont.)' : ''}</h2>`;
      return `<div class="print-field field-${c.key}"><small>${labels[c.key]}</small><div>${value}</div></div>`;
    })
    .join('')}</article>`;
}
async function readyImages(root: HTMLElement) {
  await Promise.all(
    [...root.querySelectorAll('img')].map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => {
              img.replaceWith(
                Object.assign(document.createElement('span'), { textContent: 'Image unavailable' }),
              );
              resolve();
            };
            setTimeout(() => {
              if (!img.complete)
                img.replaceWith(
                  Object.assign(document.createElement('span'), {
                    textContent: 'Image unavailable',
                  }),
                );
              resolve();
            }, 10000);
          }),
    ),
  );
}
export async function renderDocument(p: RenderPayload): Promise<RenderResult> {
  await document.fonts.ready;
  const width = p.template.orientation === 'portrait' ? 794 : 1123,
    height = p.template.orientation === 'portrait' ? 1123 : 794;
  const measure = document.createElement('div');
  measure.className = `print-page ${p.template.orientation} print-measure`;
  measure.style.width = `${width}px`;
  measure.style.height = `${height}px`;
  document.body.append(measure);
  try {
    const head = header(p),
      th = tableHead(p);
    measure.innerHTML = `${head}<div class="print-body">${th}<div class="measure-blocks"></div></div>`;
    await readyImages(measure);
    const headerHeight = measure.querySelector('.print-header')!.getBoundingClientRect().height;
    const tableHeight =
      measure.querySelector('.print-table-head')?.getBoundingClientRect().height ?? 0;
    const available = height - 88 - headerHeight - 16 - 36 - tableHeight;
    const subsequentAvailable =
      p.template.headerPages === 'first' ? available + headerHeight + 16 : available;
    const pageCapacity = (index: number) => (index === 0 ? available : subsequentAvailable);
    const body = measure.querySelector<HTMLElement>('.measure-blocks')!;
    const visible = filterItems(p.items, p.template, p.recipient?.id ?? null);
    const htmls: string[] = [];
    // Cue scripts are the only blocks that flow; split at measured word boundaries.
    for (const [index, item] of visible.entries()) {
      const gap = itemGapLabel(visible[index - 1], item);
      // Keep the omission marker with the following item, including across page breaks.
      const withGap = (html: string) =>
        gap
          ? `<div class="print-item-group"><div class="print-gap">${gap}</div>${html}</div>`
          : html;
      if (p.template.itemStyle !== 'cueCard' || !item.script || !colsHasScript(p)) {
        htmls.push(withGap(block(p, item)));
        continue;
      }
      const words = item.script.split(/\s+/);
      let remaining = words,
        continuation = false;
      while (remaining.length) {
        let low = 1,
          high = remaining.length,
          best = 1;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const html = block(
            p,
            { ...item, script: remaining.slice(0, mid).join(' ') },
            continuation,
          );
          body.innerHTML = continuation ? html : withGap(html);
          await readyImages(body);
          if (body.getBoundingClientRect().height + 12 <= pageCapacity(htmls.length)) {
            best = mid;
            low = mid + 1;
          } else high = mid - 1;
        }
        const html = block(
          p,
          { ...item, script: remaining.slice(0, best).join(' ') },
          continuation,
        );
        htmls.push(continuation ? html : withGap(html));
        remaining = remaining.slice(best);
        continuation = true;
      }
    }
    body.innerHTML = htmls.join('');
    await readyImages(body);
    const heights = [...body.children].map(
      (el) =>
        Math.ceil(el.getBoundingClientRect().height) + (p.template.itemStyle === 'table' ? 0 : 12),
    );
    const result = fitPagination(
      heights.map((h) => Math.min(h, subsequentAvailable)),
      available,
      p.template.pageMode.kind === 'fit' ? p.template.pageMode.pages : undefined,
      p.template.itemStyle === 'cueCard',
      subsequentAvailable,
    );
    // Clip against the actual page's capacity, reclaiming header space on later pages.
    result.pages.forEach((indices, index) => {
      const capacity = Math.min(subsequentAvailable, pageCapacity(index) / result.scale);
      indices.forEach((i) => {
        if (heights[i] > capacity)
          htmls[i] = `<div class="print-clipped" style="height:${capacity - 12}px">${htmls[i]}<span class="clip-notice">⋯ continues in app</span></div>`;
      });
    });
    const runtime = p.items.at(-1)?.endSec ?? 0;
    const html = result.pages
      .map(
        (indices, index) =>
          `<section class="print-page ${p.template.orientation}" style="width:${width}px;height:${height}px">${index === 0 || p.template.headerPages !== 'first' ? head : ''}<div class="print-body" style="height:${pageCapacity(index) + tableHeight}px">${th}<div class="print-scaled-body" style="transform:scale(${result.scale});transform-origin:top left;width:100%">${indices.length ? indices.map((i) => htmls[i]).join('') : '<p class="print-empty">No items match this template.</p>'}</div></div><footer class="print-footer"><span>${escape(p.template.name)}</span><span>Runtime ${formatDuration(runtime)} · ends ${time(p.session.startAt, runtime, p.event.timeZone, true)}</span><span>Page ${index + 1} of ${result.pages.length}</span></footer></section>`,
      )
      .join('');
    return { html, pageCount: result.pages.length, warning: result.warning };
  } finally {
    measure.remove();
  }
}
function colsHasScript(p: RenderPayload) {
  return p.template.columns.some((c) => c.key === 'script' && c.visible);
}
